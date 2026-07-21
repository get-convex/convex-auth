import type { GenericDataModel } from "convex/server";
import { Infer, v } from "convex/values";

import type { Hashed } from "../../shared/brand";
import * as Provider from "../crypto";
import { authDb } from "../db";
import { requireEnv } from "../env";
import { isSignInRateLimited, recordFailedSignIn, resetSignInRateLimit } from "../limits";
import { LOG_LEVELS, log } from "../log";
import type { SignInParams } from "../payloads";
import { vPayloadRecord } from "../payloads";
import { sha256 } from "../random";
import { finalizeSessionIssuance, getAuthSessionId, issueSession } from "../session/lifecycle";
import type { SessionIssuance } from "../session/lifecycle";
import { createSyntheticOAuthMaterializedConfig } from "../connection/oidc";
import { isGroupProviderId } from "../connection/shared";
import { GenericActionCtxWithAuthConfig, MutationCtx, SessionInfo } from "../types";
import { upsertUserAndAccount } from "../user/account";
import { withSpan } from "../utils/span";
import { AUTH_STORE_REF } from "./store/refs";

export const vVerifyCodeAndSignInArgs = v.object({
  params: vPayloadRecord,
  provider: v.optional(v.string()),
  verifier: v.optional(v.string()),
  generateTokens: v.boolean(),
  allowExtraProviders: v.boolean(),
});

type MutationReturnType = null | SessionIssuance;

export async function verifyCodeAndSignInImpl(
  ctx: MutationCtx,
  args: Infer<typeof vVerifyCodeAndSignInArgs>,
  getProviderOrThrow: Provider.GetProviderOrThrowFunc,
  config: Provider.Config,
): Promise<MutationReturnType> {
  return withSpan(
    "convex-auth.mutations.verifyCodeAndSignIn",
    {
      provider: args.provider ?? "",
      generateTokens: args.generateTokens,
    },
    () => verifyCodeAndSignInImplInner(ctx, args, getProviderOrThrow, config),
  );
}

async function verifyCodeAndSignInImplInner(
  ctx: MutationCtx,
  args: Infer<typeof vVerifyCodeAndSignInArgs>,
  getProviderOrThrow: Provider.GetProviderOrThrowFunc,
  config: Provider.Config,
): Promise<MutationReturnType> {
  const params = args.params as SignInParams;
  const { generateTokens, provider, allowExtraProviders } = args;
  const identifier: string | undefined =
    typeof params.email === "string"
      ? params.email
      : typeof params.phone === "string"
        ? params.phone
        : undefined;

  // Every rate-limit key this attempt is throttled and recorded against. Seeded
  // with the email/phone identifier when present, then extended with the
  // resolved code's account below. Keying on the account closes the code-only
  // bypass: a `signIn({ code })` with no email/phone previously skipped the
  // limit entirely (both the check and the failure-record were gated on
  // `identifier !== undefined`), letting a resolved code be replayed unthrottled.
  const rateLimitKeys = new Set<string>();
  if (identifier !== undefined) {
    rateLimitKeys.add(identifier);
  }

  try {
    log(LOG_LEVELS.DEBUG, "verifyCodeAndSignInImpl args:", {
      params: { email: params.email, phone: params.phone },
      provider: args.provider,
      verifier: args.verifier,
      generateTokens: args.generateTokens,
      allowExtraProviders: args.allowExtraProviders,
    });
    if (generateTokens) {
      requireEnv("JWT_PRIVATE_KEY");
      requireEnv("JWKS");
      requireEnv("CONVEX_SITE_URL");
    }

    if (identifier !== undefined && (await isSignInRateLimited(ctx, identifier, config))) {
      throw new VerifyFailure("Too many failed attempts to verify code for this email");
    }

    const db = authDb(ctx, config);
    const verifier = args.verifier;
    const codeValue = params.code;
    if (typeof codeValue !== "string") {
      throw new VerifyFailure("Invalid verification code");
    }
    const hash = (await sha256(codeValue)) as Hashed<"VerificationCode">;
    const code = await db.verificationCodes.get({ code: hash });
    if (code === null) {
      throw new VerifyFailure("Invalid verification code");
    }

    // The code resolved to an account: throttle (and, on failure below, record)
    // against that account too, so a code-only verify with no email/phone is
    // still rate-limited. Prefixed so it can never collide with an email/phone
    // identifier key. This whole handler is one mutation transaction, so the
    // check + record + reset are atomic (no TOCTOU as in the action flows).
    const accountKey = `accountId:${code.accountId}`;
    if (!rateLimitKeys.has(accountKey)) {
      rateLimitKeys.add(accountKey);
      if (await isSignInRateLimited(ctx, accountKey, config)) {
        throw new VerifyFailure("Too many failed attempts to verify code");
      }
    }

    if (code.verifier !== verifier) {
      throw new VerifyFailure("Invalid verifier");
    }
    if (code.expirationTime < Date.now()) {
      throw new VerifyFailure("Expired verification code");
    }
    if (provider !== undefined && code.provider !== provider) {
      throw new VerifyFailure(`Invalid provider "${provider}" for given \`code\``);
    }

    const account = await db.accounts.get({ id: code.accountId });
    if (account === null) {
      throw new VerifyFailure("Account associated with this email has been deleted");
    }

    const codeProvider = isGroupProviderId(code.provider)
      ? createSyntheticOAuthMaterializedConfig(code.provider)
      : getProviderOrThrow(code.provider, allowExtraProviders);

    if (
      codeProvider !== null &&
      (codeProvider.type === "email" || codeProvider.type === "phone") &&
      codeProvider.authorize !== undefined
    ) {
      await codeProvider.authorize(params, account);
    }

    const methodProvider = isGroupProviderId(account.provider)
      ? createSyntheticOAuthMaterializedConfig(account.provider)
      : getProviderOrThrow(account.provider);

    const userId =
      methodProvider.type === "oauth"
        ? account.userId
        : (
            await upsertUserAndAccount(
              ctx,
              await getAuthSessionId(ctx),
              { existingAccount: account },
              {
                type: "verification",
                provider: methodProvider,
                profile: {
                  ...(code.emailVerified !== undefined
                    ? { email: code.emailVerified, emailVerified: true }
                    : {}),
                  ...(code.phoneVerified !== undefined
                    ? { phone: code.phoneVerified, phoneVerified: true }
                    : {}),
                },
              },
              config,
            )
          ).userId;

    const [, replaceSessionId] = await Promise.all([
      db.verificationCodes.delete(code._id),
      getAuthSessionId(ctx),
    ]);
    // Successful verify: clear the failure counter for every key we accumulated
    // (email/phone plus the resolved account).
    await Promise.all([...rateLimitKeys].map((key) => resetSignInRateLimit(ctx, key, config)));

    return await issueSession(ctx, config, {
      userId,
      replaceSessionId: replaceSessionId ?? undefined,
      generateTokens,
    });
  } catch (error) {
    if (error instanceof VerifyFailure) {
      log(LOG_LEVELS.ERROR, error.reason);
      // Record the failure against every key we resolved (email/phone and, once
      // the code was found, its account). A code-only attempt whose code never
      // resolves accumulates no account key; throttling that residual would need
      // an IP/global limiter unavailable inside this mutation.
      await Promise.all([...rateLimitKeys].map((key) => recordFailedSignIn(ctx, key, config)));
      return null;
    }
    throw error;
  }
}

/** A soft verification failure -- logged and collapsed to null at the boundary. */
class VerifyFailure extends Error {
  readonly _tag = "VerifyFailure";
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = "VerifyFailure";
  }
}

/**
 * Run the verify-code-and-sign-in mutation, then sign the JWT on the action
 * side. See {@link callSignIn} for the rationale — the mutation returns
 * `SessionIssuance` (cheap string-encoded refresh token + IDs), and this
 * wrapper does the RSA-2048 work outside the mutation transaction.
 *
 * @internal
 */
export const callVerifyCodeAndSignIn = async <DataModel extends GenericDataModel>(
  ctx: GenericActionCtxWithAuthConfig<DataModel>,
  args: Infer<typeof vVerifyCodeAndSignInArgs>,
): Promise<SessionInfo | null> => {
  const issuance = (await ctx.runMutation(AUTH_STORE_REF, {
    args: {
      type: "verifyCodeAndSignIn",
      ...args,
    },
  })) as MutationReturnType;
  if (issuance === null) return null;
  return await finalizeSessionIssuance(ctx.auth.config, issuance);
};
