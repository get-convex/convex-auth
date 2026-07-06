/**
 * `component.factor.passkey.*` — WebAuthn passkey credentials.
 *
 * Reads collapse into one overloaded `get`; `update`
 * also carries the post-assertion counter sync (clone detection).
 *
 * @module
 */

import { getOneFrom } from "convex-helpers/server/relationships";
import { v } from "convex/values";

import { mutation, query } from "../functions";
import { vPasskeyDoc } from "../model";

const PASSKEY_LIST_BATCH = 128;

/** Read a passkey by `id`, or by its WebAuthn `credentialId`. */
export const get = query({
  args: {
    id: v.optional(v.id("Passkey")),
    credentialId: v.optional(v.string()),
  },
  returns: v.union(vPasskeyDoc, v.null()),
  handler: async (ctx, args) => {
    if (args.credentialId !== undefined) {
      return await getOneFrom(
        ctx.db,
        "Passkey",
        "credential_id",
        args.credentialId,
        "credentialId",
      );
    }
    if (args.id === undefined) return null;
    return await ctx.db.get("Passkey", args.id);
  },
});

/** List all passkeys for a user. */
export const list = query({
  args: { userId: v.id("User") },
  returns: v.array(vPasskeyDoc),
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("Passkey")
      .withIndex("user_id", (q) => q.eq("userId", userId))
      .take(PASSKEY_LIST_BATCH);
  },
});

/** Insert a new passkey credential. */
export const create = mutation({
  args: {
    userId: v.id("User"),
    credentialId: v.string(),
    publicKey: v.bytes(),
    algorithm: v.number(),
    counter: v.number(),
    transports: v.optional(v.array(v.string())),
    deviceType: v.string(),
    backedUp: v.boolean(),
    name: v.optional(v.string()),
    createdAt: v.number(),
  },
  returns: v.id("Passkey"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("Passkey", args);
  },
});

/** Patch fields on a passkey, including the post-assertion `counter` sync used for clone detection. */
export const update = mutation({
  args: {
    id: v.id("Passkey"),
    patch: v.object({
      counter: v.optional(v.number()),
      transports: v.optional(v.array(v.string())),
      name: v.optional(v.string()),
      lastUsedAt: v.optional(v.number()),
      backedUp: v.optional(v.boolean()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { id: passkeyId, patch }) => {
    await ctx.db.patch("Passkey", passkeyId, patch);
    return null;
  },
});

/** Delete a passkey credential. */
const remove = mutation({
  args: { id: v.id("Passkey") },
  returns: v.null(),
  handler: async (ctx, { id: passkeyId }) => {
    await ctx.db.delete("Passkey", passkeyId);
    return null;
  },
});

export { remove };
