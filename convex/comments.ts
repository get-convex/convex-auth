import { ConvexError, v } from "convex/values";

import { auth } from "./auth/core";
import { ErrorCode } from "./errors";
import { authMutation, authQuery } from "./functions";

export const list = authQuery({
  args: { issueId: v.id("issues") },
  returns: v.array(
    v.object({
      _id: v.id("comments"),
      authorName: v.string(),
      authorUserId: v.string(),
      body: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const issue = await ctx.db.get(args.issueId);
    if (!issue) return [];
    const userId = ctx.auth.userId;

    const [comments] = await Promise.all([
      ctx.db
        .query("comments")
        .withIndex("by_issueId", (q) => q.eq("issueId", issue._id))
        .take(100),
      auth.member.assert(ctx, {
        userId,
        groupId: issue.groupId,
        grants: ["projects.read"],
      }),
    ]);

    const userIds = comments.map((c) => c.authorUserId);
    const users = await auth.user.get(ctx, { ids: userIds });

    return comments.map((comment, i) => ({
      _id: comment._id,
      authorName: users[i]?.name ?? users[i]?.email ?? "Unknown user",
      authorUserId: comment.authorUserId,
      body: comment.body,
      createdAt: comment._creationTime,
    }));
  },
});

export const create = authMutation({
  args: { issueId: v.id("issues"), body: v.string() },
  returns: v.object({ commentId: v.id("comments") }),
  handler: async (ctx, args) => {
    const issue = await ctx.db.get(args.issueId);
    if (!issue) {
      throw new ConvexError({ code: ErrorCode.NOT_FOUND, message: "Issue not found." });
    }

    const body = args.body.trim();
    if (body.length === 0) {
      throw new ConvexError({
        code: ErrorCode.INVALID_INPUT,
        message: "Comment cannot be empty.",
      });
    }
    const userId = ctx.auth.userId;

    await auth.member.assert(ctx, {
      userId,
      groupId: issue.groupId,
      grants: ["comments.create"],
    });

    const commentId = await ctx.db.insert("comments", {
      issueId: issue._id,
      groupId: issue.groupId,
      authorUserId: userId,
      body,
    });

    return { commentId };
  },
});

export const remove = authMutation({
  args: { commentId: v.id("comments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const comment = await ctx.db.get(args.commentId);
    if (!comment) return null;
    const userId = ctx.auth.userId;

    if (comment.authorUserId !== userId) {
      const issue = await ctx.db.get(comment.issueId);
      if (!issue) {
        throw new ConvexError({ code: ErrorCode.NOT_FOUND, message: "Issue not found." });
      }
      await auth.member.assert(ctx, {
        userId,
        groupId: issue.groupId,
        grants: ["comments.delete"],
      });
    }

    await ctx.db.delete(args.commentId);
    return null;
  },
});
