/**
 * `component.user.email.*` — emails a user owns (sub-resource of user).
 *
 * Mirrors the consumer facade `auth.user.email.{list,add,remove,
 * primary}`.
 *
 * @module
 */

import { ConvexError, v } from "convex/values";

import { ErrorCode } from "../../shared/codes";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { mutation, query } from "../functions";
import { vUserEmailDoc, vUserEmailSource } from "../model";

const USER_EMAIL_BATCH = 64;

async function listOwnedEmails(ctx: Pick<QueryCtx | MutationCtx, "db">, userId: Id<"User">) {
  const owned = await ctx.db
    .query("UserEmail")
    .withIndex("user_id", (q) => q.eq("userId", userId))
    .take(USER_EMAIL_BATCH + 1);
  if (owned.length > USER_EMAIL_BATCH) {
    throw new ConvexError({
      code: ErrorCode.INVALID_PARAMETERS,
      message: `User has more than ${USER_EMAIL_BATCH} emails; operation is not safe in one mutation.`,
    });
  }
  return owned;
}

/** List the emails owned by a user. */
export const list = query({
  args: { userId: v.id("User") },
  returns: v.array(vUserEmailDoc),
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("UserEmail")
      .withIndex("user_id", (q) => q.eq("userId", userId))
      .take(USER_EMAIL_BATCH);
  },
});

/**
 * Add an email to a user, or patch it when the address already exists.
 * Promotes it to primary when `isPrimary` is set or it is the user's first
 * email, demoting any prior primary and syncing the denormalized `User.email`.
 */
export const upsert = mutation({
  args: {
    userId: v.id("User"),
    email: v.string(),
    verified: v.optional(v.boolean()),
    isPrimary: v.optional(v.boolean()),
    source: vUserEmailSource,
    accountId: v.optional(v.id("Account")),
    provider: v.optional(v.string()),
    connectionId: v.optional(v.id("GroupConnection")),
  },
  returns: v.id("UserEmail"),
  handler: async (ctx, args) => {
    const [owned, existing] = await Promise.all([
      listOwnedEmails(ctx, args.userId),
      ctx.db
        .query("UserEmail")
        .withIndex("user_id_email", (q) => q.eq("userId", args.userId).eq("email", args.email))
        .first(),
    ]);
    const makePrimary = args.isPrimary === true || owned.length === 0;
    const verificationTime =
      args.verified === true
        ? (existing?.verificationTime ?? Date.now())
        : existing?.verificationTime;

    if (makePrimary) {
      await Promise.all(
        owned
          .filter((e) => e.isPrimary && e._id !== existing?._id)
          .map((e) => ctx.db.patch("UserEmail", e._id, { isPrimary: false })),
      );
    }

    let id;
    if (existing !== null) {
      await ctx.db.patch("UserEmail", existing._id, {
        verificationTime,
        isPrimary: makePrimary ? true : existing.isPrimary,
        source: args.source,
        accountId: args.accountId ?? existing.accountId,
        provider: args.provider ?? existing.provider,
        connectionId: args.connectionId ?? existing.connectionId,
      });
      id = existing._id;
    } else {
      id = await ctx.db.insert("UserEmail", {
        userId: args.userId,
        email: args.email,
        verificationTime,
        isPrimary: makePrimary,
        source: args.source,
        accountId: args.accountId,
        provider: args.provider,
        connectionId: args.connectionId,
      });
    }

    if (makePrimary) {
      await ctx.db.patch("User", args.userId, {
        email: args.email,
        ...(verificationTime !== undefined ? { emailVerificationTime: verificationTime } : {}),
      });
    }
    return id;
  },
});

/**
 * Make one of a user's verified emails primary, demoting the previous primary
 * and syncing `User.email`. Rejects unowned or unverified emails.
 */
export const promote = mutation({
  args: { userId: v.id("User"), email: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, email }) => {
    const [owned, target] = await Promise.all([
      listOwnedEmails(ctx, userId),
      ctx.db
        .query("UserEmail")
        .withIndex("user_id_email", (q) => q.eq("userId", userId).eq("email", email))
        .first(),
    ]);
    if (target === null) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: "Email is not owned by this user.",
      });
    }
    if (target.verificationTime === undefined) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: "Cannot make an unverified email primary.",
      });
    }
    await Promise.all(
      owned
        .filter((e) => e.isPrimary && e._id !== target._id)
        .map((e) => ctx.db.patch("UserEmail", e._id, { isPrimary: false })),
    );
    await ctx.db.patch("UserEmail", target._id, { isPrimary: true });
    await ctx.db.patch("User", userId, {
      email: target.email,
      emailVerificationTime: target.verificationTime,
    });
    return null;
  },
});

/**
 * Remove an email a user owns. Refuses the primary email, the only verified
 * email, and emails managed by a SAML/OIDC/SCIM connection.
 */
const remove = mutation({
  args: { userId: v.id("User"), email: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, email }) => {
    const [owned, target] = await Promise.all([
      listOwnedEmails(ctx, userId),
      ctx.db
        .query("UserEmail")
        .withIndex("user_id_email", (q) => q.eq("userId", userId).eq("email", email))
        .first(),
    ]);
    if (target === null) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: "Email is not owned by this user.",
      });
    }
    if (target.isPrimary) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: "Cannot remove the primary email; set another primary first.",
      });
    }
    if (
      target.connectionId !== undefined &&
      (target.source === "saml" || target.source === "oidc" || target.source === "scim")
    ) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: "This email is managed by an Connection/SCIM connection.",
      });
    }
    const verifiedCount = owned.filter((e) => e.verificationTime !== undefined).length;
    if (target.verificationTime !== undefined && verifiedCount <= 1) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: "Cannot remove the only verified email.",
      });
    }
    await ctx.db.delete("UserEmail", target._id);
    return null;
  },
});

export { remove };
