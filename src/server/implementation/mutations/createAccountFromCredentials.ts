import { Infer, v } from "convex/values";
import { ActionCtx, Doc, MutationCtx } from "../types.js";
import * as Provider from "../provider.js";
import { ConvexCredentialsConfig } from "../../types.js";
import { upsertUserAndAccount } from "../users.js";
import { getAuthSessionId } from "../sessions.js";
import { LOG_LEVELS, logWithLevel, maybeRedact } from "../utils.js";

export const createAccountFromCredentialsArgs = v.object({
  provider: v.string(),
  account: v.object({ id: v.string(), secret: v.optional(v.string()) }),
  profile: v.any(),
  shouldLinkViaEmail: v.optional(v.boolean()),
  shouldLinkViaPhone: v.optional(v.boolean()),
  // When provided, the account is linked directly to this existing user
  // instead of upserting/linking a user from the profile. Used for adding
  // an additional credential (such as a passkey) to the signed-in user.
  userId: v.optional(v.id("users")),
});

type ReturnType = { account: Doc<"authAccounts">; user: Doc<"users"> };

export async function createAccountFromCredentialsImpl(
  ctx: MutationCtx,
  args: Infer<typeof createAccountFromCredentialsArgs>,
  getProviderOrThrow: Provider.GetProviderOrThrowFunc,
  config: Provider.Config,
): Promise<ReturnType> {
  logWithLevel(LOG_LEVELS.DEBUG, "createAccountFromCredentialsImpl args:", {
    provider: args.provider,
    account: {
      id: args.account.id,
      secret: maybeRedact(args.account.secret ?? ""),
    },
  });
  const {
    provider: providerId,
    account,
    profile,
    shouldLinkViaEmail,
    shouldLinkViaPhone,
    userId: linkToUserId,
  } = args;
  const provider = getProviderOrThrow(providerId) as ConvexCredentialsConfig;
  const existingAccount = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q.eq("provider", provider.id).eq("providerAccountId", account.id),
    )
    .unique();
  if (existingAccount !== null) {
    if (
      account.secret !== undefined &&
      !(await Provider.verify(
        provider,
        account.secret,
        existingAccount.secret ?? "",
      ))
    ) {
      throw new Error(`Account ${account.id} already exists`);
    }
    return {
      account: existingAccount,
      // TODO: Ian removed this,
      user: (await ctx.db.get(existingAccount.userId))!,
    };
  }

  const secret =
    account.secret !== undefined
      ? await Provider.hash(provider, account.secret)
      : undefined;

  // Link the new account directly to an existing user, skipping the
  // profile-based user upsert/linking entirely.
  if (linkToUserId !== undefined) {
    const user = await ctx.db.get(linkToUserId);
    if (user === null) {
      throw new Error(
        `Cannot link account to nonexistent user \`${linkToUserId}\``,
      );
    }
    const accountId = await ctx.db.insert("authAccounts", {
      userId: linkToUserId,
      provider: provider.id,
      providerAccountId: account.id,
      secret,
    });
    return { account: (await ctx.db.get(accountId))!, user };
  }

  const { userId, accountId } = await upsertUserAndAccount(
    ctx,
    await getAuthSessionId(ctx),
    { providerAccountId: account.id, secret },
    {
      type: "credentials",
      provider,
      profile,
      shouldLinkViaEmail,
      shouldLinkViaPhone,
    },
    config,
  );

  return {
    account: (await ctx.db.get(accountId))!,
    user: (await ctx.db.get(userId))!,
  };
}

export const callCreateAccountFromCredentials = async (
  ctx: ActionCtx,
  args: Infer<typeof createAccountFromCredentialsArgs>,
): Promise<ReturnType> => {
  return ctx.runMutation("auth:store" as any, {
    args: {
      type: "createAccountFromCredentials",
      ...args,
    },
  });
};
