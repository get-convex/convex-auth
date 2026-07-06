/**
 * `component.factor.totp.*` — TOTP (authenticator-app) enrollments.
 *
 * Reads collapse into one overloaded `get`. Enrollment is confirmed via
 * `update(id, { verified: true })`.
 *
 * @module
 */

import { v } from "convex/values";

import { mutation, query } from "../functions";
import { vTotpFactorDoc } from "../model";

const TOTP_LIST_BATCH = 32;

/** Read a TOTP factor by `id`, or by `verifiedForUserId` (a user's confirmed enrollment). */
export const get = query({
  args: {
    id: v.optional(v.id("TotpFactor")),
    verifiedForUserId: v.optional(v.id("User")),
  },
  returns: v.union(vTotpFactorDoc, v.null()),
  handler: async (ctx, args) => {
    if (args.verifiedForUserId !== undefined) {
      return await ctx.db
        .query("TotpFactor")
        .withIndex("user_id_verified", (q) =>
          q.eq("userId", args.verifiedForUserId!).eq("verified", true),
        )
        .first();
    }
    if (args.id === undefined) return null;
    return await ctx.db.get("TotpFactor", args.id);
  },
});

/** List all TOTP factors for a user. */
export const list = query({
  args: { userId: v.id("User") },
  returns: v.array(vTotpFactorDoc),
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("TotpFactor")
      .withIndex("user_id", (q) => q.eq("userId", userId))
      .take(TOTP_LIST_BATCH);
  },
});

/** Insert a new TOTP enrollment. */
export const create = mutation({
  args: {
    userId: v.id("User"),
    secret: v.bytes(),
    digits: v.number(),
    period: v.number(),
    verified: v.boolean(),
    name: v.optional(v.string()),
    createdAt: v.number(),
  },
  returns: v.id("TotpFactor"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("TotpFactor", args);
  },
});

/** Patch fields on a TOTP factor; setting `verified: true` confirms the enrollment. */
export const update = mutation({
  args: {
    id: v.id("TotpFactor"),
    patch: v.object({
      verified: v.optional(v.boolean()),
      name: v.optional(v.string()),
      lastUsedAt: v.optional(v.number()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { id: totpId, patch }) => {
    await ctx.db.patch("TotpFactor", totpId, patch);
    return null;
  },
});

/** Delete a TOTP factor. */
const remove = mutation({
  args: { id: v.id("TotpFactor") },
  returns: v.null(),
  handler: async (ctx, { id: totpId }) => {
    await ctx.db.delete("TotpFactor", totpId);
    return null;
  },
});

export { remove };
