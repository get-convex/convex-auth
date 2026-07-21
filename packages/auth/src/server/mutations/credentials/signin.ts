/**
 * Combined credentials-verify + session-issue mutation. Replaces the
 * separate `retrieveAccountWithCredentials` + `signIn` pair so password
 * sign-in pays one cross-component RPC instead of two.
 *
 * @internal
 */

import type { GenericDataModel } from "convex/server";
import { Infer, v } from "convex/values";

import * as Provider from "../../crypto";
import type { Hashed } from "../../../shared/brand";
import { authDb } from "../../db";
import { isSignInRateLimited, recordFailedSignIn, resetSignInRateLimit } from "../../limits";
import { LOG_LEVELS, log, maybeRedact } from "../../log";
import { getAuthSessionId, issueSession } from "../../session/lifecycle";
import type { SessionIssuance } from "../../session/lifecycle";
import { GenericActionCtxWithAuthConfig, MutationCtx } from "../../types";
import { withSpan } from "../../utils/span";
import { AUTH_STORE_REF } from "../store/refs";

/**
 * A well-formed but intentionally unmatchable password hash. Verifying any
 * secret against it runs the provider's full (scrypt) work and always fails.
 * Used on the missing-account branch so sign-in spends comparable time whether
 * or not the account exists — closing the user-enumeration timing oracle.
 *
 * The prefix and params mirror the default password provider's scrypt format so
 * that provider performs a real scrypt hash; the salt and digest are all zero,
 * a digest scrypt can never actually produce, so verification never succeeds.
 */
const DUMMY_PASSWORD_HASH =
  `scrypt:N=16384,r=16,p=1,dkLen=64$${"0".repeat(64)}$${"0".repeat(128)}` as Hashed<"Password">;

/**
 * Run a throwaway secret verification purely to equalize timing on branches
 * that reject before the real verify would run. Never authenticates: it
 * verifies against {@link DUMMY_PASSWORD_HASH} (which cannot match) and swallows
 * any error, so a misconfigured or non-credentials provider still yields the
 * unified rejection rather than a distinguishable error or timing.
 */
async function burnVerifyForTiming(
  getProviderOrThrow: Provider.GetProviderOrThrowFunc,
  providerId: string,
  secret: string,
): Promise<void> {
  try {
    await Provider.verify(getProviderOrThrow(providerId), secret, DUMMY_PASSWORD_HASH);
  } catch {
    // Intentionally ignored — this path exists only to equalize timing.
  }
}

/** Argument validator for the combined credentials-verify + session-issue mutation. */
export const vCredentialsSignInArgs = v.object({
  provider: v.string(),
  account: v.object({ id: v.string(), secret: v.string() }),
  generateTokens: v.boolean(),
  requireVerifiedEmail: v.boolean(),
  enforceTotp: v.boolean(),
});

type CredentialsSignInResult =
  | { kind: "invalidAccount" }
  | { kind: "tooManyAttempts" }
  | { kind: "invalidSecret" }
  | {
      kind: "emailVerificationRequired";
      account: { _id: string; emailVerified?: string };
      user: {
        _id: string;
        email?: string;
      };
    }
  | {
      kind: "signedIn";
      issuance: SessionIssuance;
      account: { _id: string; emailVerified?: string };
      user: {
        _id: string;
        email?: string;
        hasTotp?: boolean;
      };
    }
  | {
      kind: "totpRequired";
      issuance: SessionIssuance;
      account: { _id: string; emailVerified?: string };
      user: { _id: string; email?: string };
    };

/**
 * Verify credentials and issue a session in a single mutation.
 *
 * Enforces sign-in rate limiting, optional verified-email and TOTP gates, and
 * returns a discriminated result (`invalidAccount`, `tooManyAttempts`,
 * `invalidSecret`, `emailVerificationRequired`, `totpRequired`, or `signedIn`).
 *
 * @internal
 */
export async function credentialsSignInImpl(
  ctx: MutationCtx,
  args: Infer<typeof vCredentialsSignInArgs>,
  getProviderOrThrow: Provider.GetProviderOrThrowFunc,
  config: Provider.Config,
): Promise<CredentialsSignInResult> {
  return withSpan(
    "convex-auth.mutations.credentialsSignIn",
    { provider: args.provider, generateTokens: args.generateTokens },
    () => credentialsSignInInner(ctx, args, getProviderOrThrow, config),
  );
}

async function credentialsSignInInner(
  ctx: MutationCtx,
  args: Infer<typeof vCredentialsSignInArgs>,
  getProviderOrThrow: Provider.GetProviderOrThrowFunc,
  config: Provider.Config,
): Promise<CredentialsSignInResult> {
  const { provider: providerId, account, generateTokens, requireVerifiedEmail, enforceTotp } = args;
  const db = authDb(ctx, config);

  log(LOG_LEVELS.DEBUG, "credentialsSignInImpl args:", {
    provider: providerId,
    account: { id: account.id, secret: maybeRedact(account.secret) },
    generateTokens,
    requireVerifiedEmail,
    enforceTotp,
  });

  const existingAccount = await db.accounts.get({
    provider: providerId,
    providerAccountId: account.id,
  });
  if (existingAccount === null) {
    // A real account pays the full secret-verify (scrypt) cost below, so burn
    // the same cost here before returning the unified rejection. Without this a
    // missing account returns early and its faster response leaks (by timing)
    // that the account does not exist. Result intentionally ignored.
    await burnVerifyForTiming(getProviderOrThrow, providerId, account.secret);
    return { kind: "invalidAccount" };
  }

  const [user, rateLimited] = await Promise.all([
    db.users.get({ id: existingAccount.userId }),
    isSignInRateLimited(ctx, existingAccount._id, config),
  ]);

  if (user === null) {
    log(
      LOG_LEVELS.ERROR,
      `Account ${existingAccount._id} links to missing user ${existingAccount.userId}`,
    );
    return { kind: "invalidAccount" };
  }

  if (rateLimited) {
    return { kind: "tooManyAttempts" };
  }

  const verified = await withSpan("convex-auth.credentials.verify", { providerId }, () =>
    Provider.verify(
      getProviderOrThrow(providerId),
      account.secret,
      (existingAccount.secret ?? "") as Hashed<"Password">,
    ),
  );
  if (!verified) {
    await recordFailedSignIn(ctx, existingAccount._id, config);
    return { kind: "invalidSecret" };
  }

  if (requireVerifiedEmail && !existingAccount.emailVerified) {
    await resetSignInRateLimit(ctx, existingAccount._id, config);
    return {
      kind: "emailVerificationRequired",
      account: {
        _id: existingAccount._id,
        emailVerified: existingAccount.emailVerified,
      },
      user: {
        _id: user._id,
        email: user.email,
      },
    };
  }

  let hasTotp = false;
  if (enforceTotp) {
    const totpDoc = (await ctx.runQuery(config.component.factor.totp.get, {
      verifiedForUserId: existingAccount.userId,
    })) as { _id: string } | null;
    hasTotp = totpDoc !== null;
  }

  const totpRequired = enforceTotp && hasTotp;

  const replaceSessionId = (await getAuthSessionId(ctx)) ?? undefined;

  const [issuance] = await Promise.all([
    issueSession(ctx, config, {
      userId: existingAccount.userId,
      replaceSessionId,
      generateTokens: generateTokens && !totpRequired,
    }),
    resetSignInRateLimit(ctx, existingAccount._id, config),
  ]);

  if (totpRequired) {
    return {
      kind: "totpRequired",
      issuance,
      account: {
        _id: existingAccount._id,
        emailVerified: existingAccount.emailVerified,
      },
      user: { _id: user._id, email: user.email },
    };
  }

  return {
    kind: "signedIn",
    issuance,
    account: {
      _id: existingAccount._id,
      emailVerified: existingAccount.emailVerified,
    },
    user: {
      _id: user._id,
      email: user.email,
      hasTotp,
    },
  };
}

/** @internal */
export const callCredentialsSignIn = async <DataModel extends GenericDataModel>(
  ctx: GenericActionCtxWithAuthConfig<DataModel>,
  args: Infer<typeof vCredentialsSignInArgs>,
): Promise<CredentialsSignInResult> => {
  return (await ctx.runMutation(AUTH_STORE_REF, {
    args: {
      type: "credentialsSignIn",
      ...args,
    },
  })) as CredentialsSignInResult;
};
