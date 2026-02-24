import { Infer, v } from "convex/values";
import { ActionCtx, MutationCtx } from "../types.js";
import { GetProviderOrThrowFunc, hash } from "../provider.js";
import { LOG_LEVELS, logWithLevel, maybeRedact } from "../utils.js";
import type { ConvexAuthConfig } from "../../types.js";

export const modifyAccountArgs = v.object({
  provider: v.string(),
  account: v.object({ id: v.string(), secret: v.string() }),
});

export async function modifyAccountImpl(
  ctx: MutationCtx,
  args: Infer<typeof modifyAccountArgs>,
  getProviderOrThrow: GetProviderOrThrowFunc,
  config: ConvexAuthConfig,
): Promise<void> {
  const { provider, account } = args;
  logWithLevel(LOG_LEVELS.DEBUG, "retrieveAccountWithCredentialsImpl args:", {
    provider: provider,
    account: {
      id: account.id,
      secret: maybeRedact(account.secret ?? ""),
    },
  });
  const existingAccount = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q.eq("provider", provider).eq("providerAccountId", account.id),
    )
    .unique();
  if (existingAccount === null) {
    throw new Error(
      `Cannot modify account with ID ${account.id} because it does not exist`,
    );
  }

  // Get old doc for onUpdate trigger
  const oldDoc = config.triggers?.authAccounts?.onUpdate
    ? existingAccount
    : null;

  await ctx.db.patch(existingAccount._id, {
    secret: await hash(getProviderOrThrow(provider), account.secret),
  });

  // Call onUpdate trigger
  if (oldDoc && config.triggers?.authAccounts?.onUpdate) {
    const newDoc = (await ctx.db.get(existingAccount._id))!;
    await config.triggers.authAccounts.onUpdate(ctx, newDoc, oldDoc);
  }

  return;
}

export const callModifyAccount = async (
  ctx: ActionCtx,
  args: Infer<typeof modifyAccountArgs>,
): Promise<void> => {
  return ctx.runMutation("auth:store" as any, {
    args: {
      type: "modifyAccount",
      ...args,
    },
  });
};
