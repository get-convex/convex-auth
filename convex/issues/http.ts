import { ConvexError, v } from "convex/values";

import { internalMutation, internalQuery } from "../_generated/server";
import { ErrorCode } from "../errors";
import { issuePriority, issueStatus } from "../schema";

export const getProject = internalQuery({
  args: { projectId: v.string() },
  returns: v.union(
    v.object({
      projectId: v.id("projects"),
      groupId: v.string(),
      name: v.string(),
      identifier: v.string(),
      openIssueCount: v.number(),
      issueCounter: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (!projectId) return null;
    const project = await ctx.db.get(projectId);
    if (!project) return null;
    return {
      projectId: project._id,
      groupId: project.groupId,
      name: project.name,
      identifier: project.identifier,
      openIssueCount: project.openIssueCount ?? 0,
      issueCounter: project.issueCounter,
    };
  },
});

export const list = internalQuery({
  args: { projectId: v.string() },
  returns: v.array(
    v.object({
      issueId: v.id("issues"),
      number: v.number(),
      title: v.string(),
      status: issueStatus,
      priority: issuePriority,
      labels: v.array(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (!projectId) return [];
    const issues = await ctx.db
      .query("issues")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .order("asc")
      .take(100);
    return issues.map((issue) => ({
      issueId: issue._id,
      number: issue.number,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      labels: issue.labels ?? [],
    }));
  },
});

export const create = internalMutation({
  args: {
    projectId: v.string(),
    userId: v.string(),
    title: v.string(),
  },
  returns: v.object({ issueId: v.id("issues"), number: v.number() }),
  handler: async (ctx, args) => {
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (!projectId) {
      throw new ConvexError({ code: ErrorCode.NOT_FOUND, message: "Project not found." });
    }
    const project = await ctx.db.get(projectId);
    if (!project) {
      throw new ConvexError({ code: ErrorCode.NOT_FOUND, message: "Project not found." });
    }
    const number = project.issueCounter + 1;
    await ctx.db.patch(projectId, {
      issueCounter: number,
      openIssueCount: (project.openIssueCount ?? 0) + 1,
    });
    const issueId = await ctx.db.insert("issues", {
      projectId,
      groupId: project.groupId,
      scopeGroupId: project.groupId,
      number,
      title: args.title.trim(),
      status: "backlog",
      priority: "medium",
      createdByUserId: args.userId,
      labels: [],
      position: Date.now(),
    });
    return { issueId, number };
  },
});
