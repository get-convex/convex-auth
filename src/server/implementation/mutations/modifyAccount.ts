import { Infer, v } from "convex/values";
import { ActionCtx, MutationCtx } from "../types.js";
import { GetProviderOrThrowFunc, hash } from "../provider.js";

export const modifyAccountArgs = v.object({
  provider: v.string(),
  account: v.object({ id: v.string(), secret: v.string() }),
});

export async function modifyAccountImpl(
  ctx: MutationCtx,
  args: Infer<typeof modifyAccountArgs>,
  getProviderOrThrow: GetProviderOrThrowFunc,
): Promise<void> {
  const { provider, account } = args;
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
  await ctx.db.patch(existingAccount._id, {
    secret: await hash(getProviderOrThrow(provider), account.secret),
  });
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
