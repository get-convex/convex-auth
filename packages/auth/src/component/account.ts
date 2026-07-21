/**
 * `component.account.*` — provider-linked auth accounts.
 *
 * Reads collapse into one overloaded `get`; `list`
 * takes the owning `userId`.
 *
 * @module
 */

import { ConvexError, v } from "convex/values";
import { ErrorCode } from "../shared/codes";

import { mutation, query } from "./functions";
import { vAccountDoc } from "./model";

const ACCOUNT_LIST_BATCH = 128;

/**
 * Read an account by id, or by `{ provider, providerAccountId }` when both
 * are given. Returns `null` when no selector matches.
 */
export const get = query({
  args: {
    id: v.optional(v.id("Account")),
    provider: v.optional(v.string()),
    providerAccountId: v.optional(v.string()),
  },
  returns: v.union(vAccountDoc, v.null()),
  handler: async (ctx, args) => {
    if (args.provider !== undefined && args.providerAccountId !== undefined) {
      return await ctx.db
        .query("Account")
        .withIndex("provider_account_id", (q) =>
          q.eq("provider", args.provider!).eq("providerAccountId", args.providerAccountId!),
        )
        .unique();
    }
    if (args.id === undefined) return null;
    return await ctx.db.get("Account", args.id);
  },
});

/** List the accounts owned by a user. */
export const list = query({
  args: { userId: v.id("User") },
  returns: v.array(vAccountDoc),
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("Account")
      .withIndex("user_id_provider", (q) => q.eq("userId", userId))
      .take(ACCOUNT_LIST_BATCH);
  },
});

/** Insert a new account. */
export const create = mutation({
  args: {
    userId: v.id("User"),
    provider: v.string(),
    providerAccountId: v.string(),
    secret: v.optional(v.string()),
    extend: v.optional(v.any()),
  },
  returns: v.id("Account"),
  handler: async (ctx, args) => {
    // Dedup on the (provider, providerAccountId) identity. A bare insert let two
    // concurrent or retried provisioning ceremonies — SCIM POST retries, a
    // passkey double-submit — create duplicate Account rows, which then made
    // `account.get(...).unique()` throw on every future lookup (a permanent
    // sign-in lockout / rogue credential attribution). The index-range read plus
    // insert in this single mutation is OCC-atomic: a racing insert into the same
    // range conflicts and retries, then observes the winner's row below.
    const existing = await ctx.db
      .query("Account")
      .withIndex("provider_account_id", (q) =>
        q.eq("provider", args.provider).eq("providerAccountId", args.providerAccountId),
      )
      .first();
    if (existing !== null) {
      if (existing.userId !== args.userId) {
        // Already linked to a different user — reject rather than silently
        // attribute the identity (e.g. an attacker registering a passkey
        // credentialId that already belongs to a victim).
        throw new ConvexError({
          code: ErrorCode.ACCOUNT_ALREADY_LINKED,
          message: "This account is already linked to another user.",
        });
      }
      return existing._id;
    }
    return await ctx.db.insert("Account", args);
  },
});

/** Patch fields on an account. */
export const update = mutation({
  args: {
    id: v.id("Account"),
    patch: v.object({
      userId: v.optional(v.id("User")),
      provider: v.optional(v.string()),
      providerAccountId: v.optional(v.string()),
      secret: v.optional(v.string()),
      emailVerified: v.optional(v.string()),
      phoneVerified: v.optional(v.string()),
      extend: v.optional(v.any()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { id: accountId, patch }) => {
    await ctx.db.patch("Account", accountId, patch);
    return null;
  },
});

/**
 * Delete an account. When `requireOtherAccount` is set, refuses to delete the
 * user's last remaining account so they are never left with none.
 */
const remove = mutation({
  args: {
    id: v.id("Account"),
    requireOtherAccount: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { id: accountId, requireOtherAccount }) => {
    if (requireOtherAccount === true) {
      const doc = await ctx.db.get("Account", accountId);
      if (doc === null) {
        throw new ConvexError({
          code: ErrorCode.ACCOUNT_NOT_FOUND,
          message: "Account not found.",
        });
      }
      let otherFound = false;
      for await (const sibling of ctx.db
        .query("Account")
        .withIndex("user_id_provider", (q) => q.eq("userId", doc.userId))) {
        if (sibling._id !== accountId) {
          otherFound = true;
          break;
        }
      }
      if (!otherFound) {
        throw new ConvexError({
          code: ErrorCode.INVALID_PARAMETERS,
          message: "The provided parameters are invalid.",
        });
      }
    }
    await ctx.db.delete("Account", accountId);
    return null;
  },
});

export { remove };
