import { Infer, v } from "convex/values";
import { ActionCtx, MutationCtx } from "../types.js";
import * as Provider from "../provider.js";
import { OAuthConfig } from "@auth/core/providers/oauth.js";
import { upsertUserAndAccount } from "../users.js";
import { generateRandomString, logWithLevel, sha256 } from "../utils.js";

const OAUTH_SIGN_IN_EXPIRATION_MS = 1000 * 60 * 2; // 2 minutes

export const userOAuthArgs = v.object({
  provider: v.string(),
  providerAccountId: v.string(),
  profile: v.any(),
  signature: v.string(),
});

type ReturnType = string;

export async function userOAuthImpl(
  ctx: MutationCtx,
  args: Infer<typeof userOAuthArgs>,
  getProviderOrThrow: Provider.GetProviderOrThrowFunc,
  config: Provider.Config,
): Promise<ReturnType> {
  logWithLevel("DEBUG", "userOAuthImpl args:", args);
  const { profile, provider, providerAccountId, signature } = args;
  const providerConfig = getProviderOrThrow(provider) as OAuthConfig<any>;
  const existingAccount = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q.eq("provider", provider).eq("providerAccountId", providerAccountId),
    )
    .unique();

  const verifier = await ctx.db
    .query("authVerifiers")
    .withIndex("signature", (q) => q.eq("signature", signature))
    .unique();
  if (verifier === null) {
    throw new Error("Invalid state");
  }

  const { accountId } = await upsertUserAndAccount(
    ctx,
    verifier.sessionId ?? null,
    existingAccount !== null ? { existingAccount } : { providerAccountId },
    { type: "oauth", provider: providerConfig, profile },
    config,
  );

  const code = generateRandomString(8, "0123456789");
  await ctx.db.delete(verifier._id);
  const existingVerificationCode = await ctx.db
    .query("authVerificationCodes")
    .withIndex("accountId", (q) => q.eq("accountId", accountId))
    .unique();
  if (existingVerificationCode !== null) {
    await ctx.db.delete(existingVerificationCode._id);
  }
  await ctx.db.insert("authVerificationCodes", {
    code: await sha256(code),
    accountId,
    provider,
    expirationTime: Date.now() + OAUTH_SIGN_IN_EXPIRATION_MS,
    // The use of a verifier means we don't need an identifier
    // during verification.
    verifier: verifier._id,
  });
  return code;
}

export const callUserOAuth = async (
  ctx: ActionCtx,
  args: Infer<typeof userOAuthArgs>,
): Promise<ReturnType> => {
  return ctx.runMutation("auth:store" as any, {
    args: {
      type: "userOAuth",
      ...args,
    },
  });
};
