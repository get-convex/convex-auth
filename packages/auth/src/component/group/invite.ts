/**
 * `component.group.invite.*` — group invitations (sub-resource of group).
 *
 * `accept` (overloaded by id or token) and `revoke` are domain verbs
 * (acceptance workflow with side-effects).
 *
 * @module
 */

import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { stream } from "convex-helpers/server/stream";

import { ErrorCode } from "../../shared/codes";
import type { Id } from "../_generated/dataModel";
import { mutation, query } from "../functions";
import schema from "../schema";
import { vGroupInviteDoc, vInviteAcceptResult, vInviteStatus, vPaginated } from "../model";

const STALE_INVITE_EXPIRATION_BATCH = 32;

/** Read an invite by `id`, or by `tokenHash` (the indexed redemption token). */
export const get = query({
  args: {
    id: v.optional(v.id("GroupInvite")),
    tokenHash: v.optional(v.string()),
  },
  returns: v.union(vGroupInviteDoc, v.null()),
  handler: async (ctx, args) => {
    if (args.tokenHash !== undefined) {
      return await ctx.db
        .query("GroupInvite")
        .withIndex("token_hash", (q) => q.eq("tokenHash", args.tokenHash!))
        .first();
    }
    if (args.id === undefined) return null;
    return await ctx.db.get("GroupInvite", args.id);
  },
});

/** List invites, paginated, optionally filtered by `where` and sorted via `orderBy`/`order`. */
export const list = query({
  args: {
    where: v.optional(
      v.object({
        tokenHash: v.optional(v.string()),
        groupId: v.optional(v.id("Group")),
        status: v.optional(vInviteStatus),
        email: v.optional(v.string()),
        invitedByUserId: v.optional(v.id("User")),
        acceptedByUserId: v.optional(v.id("User")),
      }),
    ),
    paginationOpts: paginationOptsValidator,
    orderBy: v.optional(
      v.union(
        v.literal("_creationTime"),
        v.literal("status"),
        v.literal("email"),
        v.literal("expiresTime"),
        v.literal("acceptedTime"),
      ),
    ),
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  returns: vPaginated(vGroupInviteDoc),
  handler: async (ctx, args) => {
    const where = args.where ?? {};
    const order = args.order ?? "desc";

    const base = stream(ctx.db, schema).query("GroupInvite");
    let q;
    if (where.tokenHash !== undefined) {
      q = base.withIndex("token_hash", (idx) => idx.eq("tokenHash", where.tokenHash!));
    } else if (where.groupId !== undefined && where.status !== undefined) {
      q = base.withIndex("group_id_status", (idx) =>
        idx.eq("groupId", where.groupId!).eq("status", where.status!),
      );
    } else if (where.email !== undefined && where.status !== undefined) {
      q = base.withIndex("email_status", (idx) =>
        idx.eq("email", where.email!).eq("status", where.status!),
      );
    } else if (where.invitedByUserId !== undefined && where.status !== undefined) {
      q = base.withIndex("invited_by_user_id_status", (idx) =>
        idx.eq("invitedByUserId", where.invitedByUserId!).eq("status", where.status!),
      );
    } else if (where.groupId !== undefined) {
      q = base.withIndex("group_id", (idx) => idx.eq("groupId", where.groupId!));
    } else if (where.status !== undefined) {
      q = base.withIndex("status", (idx) => idx.eq("status", where.status!));
    } else {
      q = base;
    }

    return await q
      .order(order)
      .filterWith(
        async (d) =>
          (where.groupId === undefined || d.groupId === where.groupId) &&
          (where.status === undefined || d.status === where.status) &&
          (where.email === undefined || d.email === where.email) &&
          (where.invitedByUserId === undefined || d.invitedByUserId === where.invitedByUserId) &&
          (where.acceptedByUserId === undefined || d.acceptedByUserId === where.acceptedByUserId) &&
          (where.tokenHash === undefined || d.tokenHash === where.tokenHash),
      )
      .paginate(args.paginationOpts);
  },
});

/**
 * Insert a new invite. For email invites, rejects a duplicate pending invite
 * (per group, or platform-wide when `groupId` is absent) with
 * `DUPLICATE_INVITE`, lazily expiring any stale pending matches first.
 */
export const create = mutation({
  args: {
    groupId: v.optional(v.id("Group")),
    invitedByUserId: v.optional(v.id("User")),
    email: v.optional(v.string()),
    tokenHash: v.string(),
    roleIds: v.optional(v.array(v.string())),
    status: vInviteStatus,
    expiresTime: v.optional(v.number()),
    extend: v.optional(v.any()),
  },
  returns: v.id("GroupInvite"),
  handler: async (ctx, args) => {
    const now = Date.now();

    if (args.email !== undefined) {
      if (args.groupId !== undefined) {
        for (let checked = 0; checked < STALE_INVITE_EXPIRATION_BATCH; checked += 1) {
          const existingGroupInvite = await ctx.db
            .query("GroupInvite")
            .withIndex("group_id_email_status", (q) =>
              q.eq("groupId", args.groupId).eq("email", args.email).eq("status", "pending"),
            )
            .first();
          if (existingGroupInvite === null) {
            break;
          }
          const isExpired =
            existingGroupInvite.expiresTime !== undefined && existingGroupInvite.expiresTime <= now;
          if (isExpired) {
            // Clear `expiresTime` on the terminal transition so the row leaves
            // the `expires_time` retention index; `maintenance.pruneExpired`
            // reclaims terminal invites by age instead (avoids index-front
            // starvation).
            await ctx.db.patch("GroupInvite", existingGroupInvite._id, {
              status: "expired",
              expiresTime: undefined,
            });
            continue;
          }
          throw new ConvexError({
            code: ErrorCode.DUPLICATE_INVITE,
            message: "A pending invite already exists for this email in this group",
            email: args.email,
            groupId: args.groupId,
            existingInviteId: existingGroupInvite._id,
          });
        }
        const remainingGroupInvite = await ctx.db
          .query("GroupInvite")
          .withIndex("group_id_email_status", (q) =>
            q.eq("groupId", args.groupId).eq("email", args.email).eq("status", "pending"),
          )
          .first();
        if (remainingGroupInvite !== null) {
          throw new ConvexError({
            code: ErrorCode.DUPLICATE_INVITE,
            message: "Too many stale pending invites for this email in this group",
            email: args.email,
            groupId: args.groupId,
            existingInviteId: remainingGroupInvite._id,
          });
        }
      } else {
        for (let checked = 0; checked < STALE_INVITE_EXPIRATION_BATCH; checked += 1) {
          const existingPlatformInvite = await ctx.db
            .query("GroupInvite")
            .withIndex("email_group_id_status", (q) =>
              q.eq("email", args.email).eq("groupId", undefined).eq("status", "pending"),
            )
            .first();
          if (existingPlatformInvite === null) {
            break;
          }
          const isExpired =
            existingPlatformInvite.expiresTime !== undefined &&
            existingPlatformInvite.expiresTime <= now;
          if (isExpired) {
            // Clear `expiresTime` on the terminal transition (see the group-path
            // note above).
            await ctx.db.patch("GroupInvite", existingPlatformInvite._id, {
              status: "expired",
              expiresTime: undefined,
            });
            continue;
          }
          throw new ConvexError({
            code: ErrorCode.DUPLICATE_INVITE,
            message: "A pending platform invite already exists for this email",
            email: args.email,
            existingInviteId: existingPlatformInvite._id,
          });
        }
        const remainingPlatformInvite = await ctx.db
          .query("GroupInvite")
          .withIndex("email_group_id_status", (q) =>
            q.eq("email", args.email).eq("groupId", undefined).eq("status", "pending"),
          )
          .first();
        if (remainingPlatformInvite !== null) {
          throw new ConvexError({
            code: ErrorCode.DUPLICATE_INVITE,
            message: "Too many stale pending platform invites for this email",
            email: args.email,
            existingInviteId: remainingPlatformInvite._id,
          });
        }
      }
    }
    return await ctx.db.insert("GroupInvite", args);
  },
});

/**
 * Accept an invite. Overloaded by selector:
 *
 * - `{ id, acceptedByUserId? }` — mark a pending invite (by id) accepted,
 *   stamping `acceptedTime`/`acceptedByUserId`, WITHOUT creating a membership
 *   (admin-driven). Returns `null`.
 * - `{ tokenHash, acceptedByUserId }` — accept by token on behalf of a user:
 *   validate status/expiry and (for email invites) that the user's email
 *   matches, then accept it and, for group invites, create the membership if
 *   absent. Idempotent for the same user. Returns a summary `{ inviteId,
 *   groupId, memberId, inviteStatus, membershipStatus }` distinguishing fresh
 *   accepts/joins from repeats.
 *
 * Throws if the invite is missing, not pending (the token form also allows an
 * invite already accepted by the same user), expired, or the email mismatches.
 */
export const accept = mutation({
  args: {
    id: v.optional(v.id("GroupInvite")),
    tokenHash: v.optional(v.string()),
    acceptedByUserId: v.optional(v.id("User")),
  },
  returns: v.union(v.null(), vInviteAcceptResult),
  handler: async (ctx, { id, tokenHash, acceptedByUserId }) => {
    if (tokenHash !== undefined) {
      if (acceptedByUserId === undefined) {
        throw new ConvexError({
          code: ErrorCode.INVALID_PARAMETERS,
          message: "acceptedByUserId is required when accepting by token.",
        });
      }
      const invite = await ctx.db
        .query("GroupInvite")
        .withIndex("token_hash", (q) => q.eq("tokenHash", tokenHash))
        .first();

      if (invite === null) {
        throw new ConvexError({
          code: ErrorCode.INVITE_NOT_FOUND,
          message: "Invite not found",
        });
      }

      const now = Date.now();
      if (invite.status === "pending") {
        if (invite.expiresTime !== undefined && invite.expiresTime <= now) {
          // Clear `expiresTime` on the terminal transition so the row leaves the
          // `expires_time` retention index (reclaimed by age in maintenance).
          await ctx.db.patch("GroupInvite", invite._id, {
            status: "expired",
            expiresTime: undefined,
          });
          throw new ConvexError({
            code: ErrorCode.INVITE_EXPIRED,
            message: "Invite has expired",
            inviteId: invite._id,
          });
        }
      } else if (invite.status === "accepted") {
        if (invite.acceptedByUserId !== acceptedByUserId) {
          throw new ConvexError({
            code: ErrorCode.INVITE_ALREADY_ACCEPTED,
            message: "Invite already accepted by another user",
            inviteId: invite._id,
          });
        }
      } else {
        throw new ConvexError({
          code: ErrorCode.INVITE_NOT_PENDING,
          message: `Cannot accept invite with status "${invite.status}"`,
          inviteId: invite._id,
          currentStatus: invite.status,
        });
      }

      if (invite.email !== undefined) {
        const user = await ctx.db.get("User", acceptedByUserId);
        const normalizedInviteEmail = invite.email.trim().toLowerCase();
        const normalizedUserEmail = user?.email?.trim().toLowerCase();

        if (normalizedUserEmail === undefined || normalizedUserEmail !== normalizedInviteEmail) {
          throw new ConvexError({
            code: ErrorCode.INVITE_EMAIL_MISMATCH,
            message: "Invite email does not match accepting user's email",
            inviteId: invite._id,
          });
        }
      }

      let membershipStatus: "joined" | "already_joined" | "not_applicable" = "not_applicable";
      let memberId: Id<"GroupMember"> | undefined;

      if (invite.groupId !== undefined) {
        const existingMembership = await ctx.db
          .query("GroupMember")
          .withIndex("group_id_user_id", (q) =>
            q.eq("groupId", invite.groupId!).eq("userId", acceptedByUserId),
          )
          .unique();

        if (existingMembership !== null) {
          membershipStatus = "already_joined";
          memberId = existingMembership._id;
        } else {
          memberId = await ctx.db.insert("GroupMember", {
            groupId: invite.groupId,
            userId: acceptedByUserId,
            roleIds: invite.roleIds,
            status: "active",
          });
          membershipStatus = "joined";
        }
      }

      if (invite.status === "pending") {
        await ctx.db.patch("GroupInvite", invite._id, {
          status: "accepted",
          acceptedByUserId,
          acceptedTime: now,
        });
      }

      const inviteStatus: "accepted" | "already_accepted" =
        invite.status === "accepted" ? "already_accepted" : "accepted";

      return {
        inviteId: invite._id,
        groupId: invite.groupId ?? null,
        memberId,
        inviteStatus,
        membershipStatus,
      };
    }

    if (id === undefined) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: "accept requires either an `id` or a `tokenHash`.",
      });
    }

    const invite = await ctx.db.get("GroupInvite", id);
    if (invite === null) {
      throw new ConvexError({
        code: ErrorCode.INVITE_NOT_FOUND,
        message: "Invite not found",
        inviteId: id,
      });
    }
    if (invite.status !== "pending") {
      throw new ConvexError({
        code: ErrorCode.INVITE_NOT_PENDING,
        message: `Cannot accept invite with status "${invite.status}"`,
        inviteId: id,
        currentStatus: invite.status,
      });
    }
    if (invite.expiresTime !== undefined && invite.expiresTime <= Date.now()) {
      // Clear `expiresTime` on the terminal transition (reclaimed by age in
      // maintenance instead of via the `expires_time` index).
      await ctx.db.patch("GroupInvite", id, {
        status: "expired",
        expiresTime: undefined,
      });
      throw new ConvexError({
        code: ErrorCode.INVITE_EXPIRED,
        message: "Invite has expired",
        inviteId: id,
      });
    }
    await ctx.db.patch("GroupInvite", id, {
      status: "accepted",
      acceptedTime: Date.now(),
      ...(acceptedByUserId ? { acceptedByUserId } : {}),
    });
    return null;
  },
});

/** Revoke a pending invite, flipping its status to `revoked`. Throws if it is missing or not pending. */
export const revoke = mutation({
  args: { id: v.id("GroupInvite") },
  returns: v.null(),
  handler: async (ctx, { id: inviteId }) => {
    const invite = await ctx.db.get("GroupInvite", inviteId);
    if (invite === null) {
      throw new ConvexError({
        code: ErrorCode.INVITE_NOT_FOUND,
        message: "Invite not found",
        inviteId,
      });
    }
    if (invite.status !== "pending") {
      throw new ConvexError({
        code: ErrorCode.INVITE_NOT_PENDING,
        message: `Cannot revoke invite with status "${invite.status}"`,
        inviteId,
        currentStatus: invite.status,
      });
    }
    // Clear `expiresTime` on the terminal transition so the row leaves the
    // `expires_time` retention index; `maintenance.pruneExpired` reclaims
    // revoked invites by age.
    await ctx.db.patch("GroupInvite", inviteId, {
      status: "revoked",
      expiresTime: undefined,
    });
    return null;
  },
});
