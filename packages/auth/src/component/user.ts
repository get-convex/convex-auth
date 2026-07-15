/**
 * `component.user.*` — the User entity surface.
 *
 * Reads collapse into one overloaded `get`; the rest are 1:1 verbs.
 *
 * @module
 */

import { stream } from "convex-helpers/server/stream";
import { partial } from "convex-helpers/validators";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { ErrorCode } from "../shared/codes";

import { mutation, query } from "./functions";
import { vPaginated, vUserDoc } from "./model";
import schema from "./schema";

const vUserInsertData = v.object(schema.tables.User.validator.fields);

const vUserPatchData = v.object(partial(schema.tables.User.validator.fields));

const CASCADE_MAX = 1000;

const tooMany = (count: number) => count > CASCADE_MAX;

/**
 * Read a user by identity. One overloaded function (single Convex
 * function with a unioned `args`/`returns`). Accepts exactly one
 * selector:
 *
 * - `{ id }`           → `Doc<"User"> | null`
 * - `{ ids }`          → `(Doc<"User"> | null)[]` (order preserved, deduped)
 * - `{ verifiedEmail }`→ `Doc<"User"> | null` (exactly-one-or-null)
 * - `{ verifiedPhone }`→ `Doc<"User"> | null` (exactly-one-or-null)
 *
 * @example
 * ```ts
 * await ctx.runQuery(component.user.get, { id: userId });
 * await ctx.runQuery(component.user.get, { ids: memberIds });
 * await ctx.runQuery(component.user.get, { verifiedEmail: "a@b.com" });
 * ```
 */
export const get = query({
  args: {
    id: v.optional(v.id("User")),
    ids: v.optional(v.array(v.id("User"))),
    verifiedEmail: v.optional(v.string()),
    verifiedPhone: v.optional(v.string()),
  },
  returns: v.union(vUserDoc, v.null(), v.array(v.union(vUserDoc, v.null()))),
  handler: async (ctx, args) => {
    if (args.ids !== undefined) {
      if (args.ids.length === 0) return [];
      const unique = Array.from(new Set(args.ids));
      const docs = await Promise.all(unique.map((id) => ctx.db.get("User", id)));
      const byId = new Map(unique.map((id, i) => [id, docs[i] ?? null]));
      return args.ids.map((id) => byId.get(id) ?? null);
    }
    if (args.verifiedEmail !== undefined) {
      const users = await ctx.db
        .query("User")
        .withIndex("email_verified", (q) =>
          q.eq("email", args.verifiedEmail!).gt("emailVerificationTime", undefined),
        )
        .take(2);
      return users.length === 1 ? users[0] : null;
    }
    if (args.verifiedPhone !== undefined) {
      const users = await ctx.db
        .query("User")
        .withIndex("phone_verified", (q) =>
          q.eq("phone", args.verifiedPhone!).gt("phoneVerificationTime", undefined),
        )
        .take(2);
      return users.length === 1 ? users[0] : null;
    }
    if (args.id === undefined) return null;
    return await ctx.db.get("User", args.id);
  },
});

/** List users, paginated, with optional `where` filters and ordering. */
export const list = query({
  args: {
    where: v.optional(
      v.object({
        email: v.optional(v.string()),
        phone: v.optional(v.string()),
        isAnonymous: v.optional(v.boolean()),
        name: v.optional(v.string()),
      }),
    ),
    paginationOpts: paginationOptsValidator,
    orderBy: v.optional(
      v.union(
        v.literal("_creationTime"),
        v.literal("name"),
        v.literal("email"),
        v.literal("phone"),
      ),
    ),
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  returns: vPaginated(vUserDoc),
  handler: async (ctx, args) => {
    const where = args.where ?? {};
    const order = args.order ?? "desc";
    const orderBy = args.orderBy ?? "_creationTime";

    const base = stream(ctx.db, schema).query("User");
    let q;
    if (orderBy === "email" || where.email !== undefined) {
      q =
        where.email !== undefined
          ? base.withIndex("email", (idx) => idx.eq("email", where.email!))
          : base.withIndex("email");
    } else if (orderBy === "phone" || where.phone !== undefined) {
      q =
        where.phone !== undefined
          ? base.withIndex("phone", (idx) => idx.eq("phone", where.phone!))
          : base.withIndex("phone");
    } else {
      q = base;
    }

    return await q
      .order(order)
      .filterWith(
        async (d) =>
          (where.isAnonymous === undefined || d.isAnonymous === where.isAnonymous) &&
          (where.name === undefined || d.name === where.name) &&
          (where.email === undefined || d.email === where.email) &&
          (where.phone === undefined || d.phone === where.phone),
      )
      .paginate(args.paginationOpts);
  },
});

/** Insert a new user. */
export const create = mutation({
  args: { data: vUserInsertData },
  returns: v.id("User"),
  handler: async (ctx, { data }) => {
    return await ctx.db.insert("User", data);
  },
});

/** Insert a user, or patch it when `id` is supplied. Returns the user id. */
export const upsert = mutation({
  args: { id: v.optional(v.id("User")), data: vUserInsertData },
  returns: v.id("User"),
  handler: async (ctx, { id, data }) => {
    if (id !== undefined) {
      await ctx.db.patch("User", id, data);
      return id;
    }
    return await ctx.db.insert("User", data);
  },
});

/** Patch fields on a user. */
export const update = mutation({
  args: { id: v.id("User"), patch: vUserPatchData },
  returns: v.null(),
  handler: async (ctx, { id, patch }) => {
    await ctx.db.patch("User", id, patch);
    return null;
  },
});

/**
 * Delete a user. Without `cascade` it refuses when any child row (session,
 * account, key, group membership, passkey, or TOTP factor) still exists. With
 * `cascade`, it deletes those children and refresh tokens too, throwing
 * `CASCADE_TOO_LARGE` past ~1000 rows per table. Owned emails are always
 * removed.
 */
const remove = mutation({
  args: {
    id: v.id("User"),
    cascade: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { id: userId, cascade }) => {
    const user = await ctx.db.get("User", userId);
    if (user === null) return null;

    if (cascade !== true) {
      const [session, account, key, member, passkey, totp] = await Promise.all([
        ctx.db
          .query("Session")
          .withIndex("user_id", (q) => q.eq("userId", userId))
          .first(),
        ctx.db
          .query("Account")
          .withIndex("user_id_provider", (q) => q.eq("userId", userId))
          .first(),
        ctx.db
          .query("ApiKey")
          .withIndex("user_id", (q) => q.eq("userId", userId))
          .first(),
        ctx.db
          .query("GroupMember")
          .withIndex("user_id", (q) => q.eq("userId", userId))
          .first(),
        ctx.db
          .query("Passkey")
          .withIndex("user_id", (q) => q.eq("userId", userId))
          .first(),
        ctx.db
          .query("TotpFactor")
          .withIndex("user_id", (q) => q.eq("userId", userId))
          .first(),
      ]);
      if (
        session !== null ||
        account !== null ||
        key !== null ||
        member !== null ||
        passkey !== null ||
        totp !== null
      ) {
        throw new ConvexError({
          code: ErrorCode.INVALID_PARAMETERS,
          message: "The provided parameters are invalid.",
        });
      }
    }

    if (cascade === true) {
      const [sessions, accounts, keys, members, passkeys, totps] = await Promise.all([
        ctx.db
          .query("Session")
          .withIndex("user_id", (q) => q.eq("userId", userId))
          .take(CASCADE_MAX + 1),
        ctx.db
          .query("Account")
          .withIndex("user_id_provider", (q) => q.eq("userId", userId))
          .take(CASCADE_MAX + 1),
        ctx.db
          .query("ApiKey")
          .withIndex("user_id", (q) => q.eq("userId", userId))
          .take(CASCADE_MAX + 1),
        ctx.db
          .query("GroupMember")
          .withIndex("user_id", (q) => q.eq("userId", userId))
          .take(CASCADE_MAX + 1),
        ctx.db
          .query("Passkey")
          .withIndex("user_id", (q) => q.eq("userId", userId))
          .take(CASCADE_MAX + 1),
        ctx.db
          .query("TotpFactor")
          .withIndex("user_id", (q) => q.eq("userId", userId))
          .take(CASCADE_MAX + 1),
      ]);
      if (
        tooMany(sessions.length) ||
        tooMany(accounts.length) ||
        tooMany(keys.length) ||
        tooMany(members.length) ||
        tooMany(passkeys.length) ||
        tooMany(totps.length)
      ) {
        throw new ConvexError({
          code: ErrorCode.CASCADE_TOO_LARGE,
          message: `User has more than ${CASCADE_MAX} child rows in one or more tables; cascade delete is not safe in a single mutation. Use the migrations component to drain children first, then call delete without cascade.`,
        });
      }
      const refreshTokens =
        sessions.length > 0
          ? (
              await Promise.all(
                sessions.map((s) =>
                  ctx.db
                    .query("RefreshToken")
                    .withIndex("session_id", (q) => q.eq("sessionId", s._id))
                    .take(CASCADE_MAX + 1),
                ),
              )
            ).flat()
          : [];
      if (tooMany(refreshTokens.length)) {
        throw new ConvexError({
          code: ErrorCode.CASCADE_TOO_LARGE,
          message: `User has more than ${CASCADE_MAX} refresh tokens across sessions; cascade delete is not safe in a single mutation.`,
        });
      }
      await Promise.all([
        ...sessions.map((s) => ctx.db.delete("Session", s._id)),
        ...refreshTokens.map((r) => ctx.db.delete("RefreshToken", r._id)),
        ...accounts.map((a) => ctx.db.delete("Account", a._id)),
        ...keys.map((k) => ctx.db.delete("ApiKey", k._id)),
        ...members.map((m) => ctx.db.delete("GroupMember", m._id)),
        ...passkeys.map((p) => ctx.db.delete("Passkey", p._id)),
        ...totps.map((t) => ctx.db.delete("TotpFactor", t._id)),
      ]);
    }
    const ownedEmails = await ctx.db
      .query("UserEmail")
      .withIndex("user_id", (q) => q.eq("userId", userId))
      .take(CASCADE_MAX + 1);
    if (tooMany(ownedEmails.length)) {
      throw new ConvexError({
        code: ErrorCode.CASCADE_TOO_LARGE,
        message: `User has more than ${CASCADE_MAX} emails; cascade delete is not safe in a single mutation.`,
      });
    }
    await Promise.all(ownedEmails.map((e) => ctx.db.delete("UserEmail", e._id)));

    await ctx.db.delete("User", userId);
    return null;
  },
});

export { remove };
