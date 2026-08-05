/**
 * REAL, working app code — not stubs. Guests create real rows here; the
 * point of this fixture is that upgrading the account leaves them untouched
 * (same userId before and after).
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/** The current user's todos (anonymous users are users like any other). */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return [];
    }
    return await ctx.db
      .query("todos")
      .withIndex("by_user", (q) =>
        q.eq("userId", identity.subject as Id<"users">),
      )
      .collect();
  },
});

export const add = mutation({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new Error("Not signed in");
    }
    await ctx.db.insert("todos", {
      userId: identity.subject as Id<"users">,
      text: args.text,
    });
  },
});
