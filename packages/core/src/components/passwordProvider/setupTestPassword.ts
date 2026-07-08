import { internalMutationGeneric } from "convex/server";
import { v } from "convex/values";

const passwordFormatUserError = v.union(
  v.object({
    error: v.literal("PASSWORD_TOO_SHORT"),
    minimumLength: v.number(),
  }),
  v.object({
    error: v.literal("PASSWORD_TOO_LONG"),
    maximumLength: v.number(),
  }),
  v.object({ error: v.literal("PASSWORD_HAS_SURROUNDING_WHITESPACE") }),
);

const setPasswordResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({ success: v.literal(false), userError: passwordFormatUserError }),
);

const verifyPasswordResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      passwordFormatUserError,
      v.object({ error: v.literal("INVALID_CREDENTIALS") }),
      v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
    ),
  }),
);

export const setPassword = internalMutationGeneric({
  args: { userId: v.string(), password: v.string() },
  returns: setPasswordResult,
  handler: async (ctx, args) => {
    await ctx.db.insert("passwords", {
      userId: args.userId,
      passwordHashPHC: args.password,
    });
    return { success: true as const };
  },
});

export const verifyPassword = internalMutationGeneric({
  args: { userId: v.string(), password: v.string() },
  returns: verifyPasswordResult,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("passwords")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (row?.passwordHashPHC !== args.password) {
      return {
        success: false as const,
        userError: { error: "INVALID_CREDENTIALS" as const },
      };
    }
    return { success: true as const };
  },
});
