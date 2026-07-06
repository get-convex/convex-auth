import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { env, query, internalMutation } from "./_generated/server";
import { auth } from "./auth/core";
import { ErrorCode } from "./errors";
import { authAction, authMutation, authQuery } from "./functions";
import { roles } from "./roles";

const validRoleIds = [roles.orgAdmin.id, roles.member.id, roles.viewer.id] as const;

function toSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function getUserRoleLabel(roleIds: string[]) {
  if (roleIds.includes(roles.orgAdmin.id)) return "Admin";
  if (roleIds.includes(roles.member.id)) return "Member";
  if (roleIds.includes(roles.viewer.id)) return "Viewer";
  return "Unassigned";
}

function getPermissions(grants: string[]) {
  return {
    canReadProjects: grants.includes("projects.read"),
    canCreateProjects: grants.includes("projects.create"),
    canManageProjects: grants.includes("projects.manage"),
    canCreateIssues: grants.includes("issues.create"),
    canEditIssues: grants.includes("issues.edit"),
    canMoveIssues: grants.includes("issues.move"),
    canAssignIssues: grants.includes("issues.assign"),
    canDeleteIssues: grants.includes("issues.delete"),
    canCreateComments: grants.includes("comments.create"),
    canDeleteComments: grants.includes("comments.delete"),
    canManageMembers: grants.includes("members.manage"),
    canManageConnection: grants.includes("connection.manage"),
    canManageScim: grants.includes("scim.manage"),
  };
}

const vUser = v.object({
  userId: v.string(),
  name: v.string(),
  email: v.union(v.string(), v.null()),
});

const vGroup = v.object({
  groupId: v.string(),
  name: v.string(),
  roleIds: v.array(v.string()),
  grants: v.array(v.string()),
});

const vMember = v.object({
  memberId: v.string(),
  userId: v.string(),
  name: v.string(),
  email: v.union(v.string(), v.null()),
  roleIds: v.array(v.string()),
  status: v.string(),
});

const vInvite = v.object({
  inviteId: v.string(),
  email: v.union(v.string(), v.null()),
  roleIds: v.array(v.string()),
  createdAt: v.number(),
});

const vPermissions = v.object({
  canReadProjects: v.boolean(),
  canCreateProjects: v.boolean(),
  canManageProjects: v.boolean(),
  canCreateIssues: v.boolean(),
  canEditIssues: v.boolean(),
  canMoveIssues: v.boolean(),
  canAssignIssues: v.boolean(),
  canDeleteIssues: v.boolean(),
  canCreateComments: v.boolean(),
  canDeleteComments: v.boolean(),
  canManageMembers: v.boolean(),
  canManageConnection: v.boolean(),
  canManageScim: v.boolean(),
});

const vProject = v.object({
  projectId: v.id("projects"),
  name: v.string(),
  identifier: v.string(),
  slug: v.string(),
  description: v.string(),
  status: v.string(),
  issueCount: v.number(),
  openIssueCount: v.number(),
});

type GroupRow = {
  groupId: string;
  name: string;
  roleIds: string[];
  grants: string[];
};

export const emailExists = query({
  args: { email: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const result = await auth.user.list(ctx, {
      where: { email: args.email.trim().toLowerCase() },
      paginationOpts: { numItems: 1, cursor: null },
    });
    return result.page.length > 0;
  },
});

export const authProviders = query({
  args: {},
  returns: v.object({ google: v.boolean() }),
  handler: async () => ({
    google: Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET),
  }),
});

export const list = authQuery({
  args: {},
  returns: v.array(
    v.object({
      groupId: v.string(),
      name: v.string(),
      roleIds: v.array(v.string()),
      userRoleLabel: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const userId = ctx.auth.userId;
    const memberships = await auth.member.list(ctx, {
      where: { userId },
      paginationOpts: { numItems: 50, cursor: null },
      orderBy: "_creationTime",
      order: "asc",
    });
    const groupIds: readonly string[] = memberships.page.map((m) => m.groupId);
    const groupDocs = await auth.group.get(ctx, { ids: groupIds });
    return memberships.page.flatMap((m, i) => {
      const group = groupDocs[i];
      if (!group) return [];
      return [
        {
          groupId: group._id,
          name: group.name,
          roleIds: m.roleIds ?? [],
          userRoleLabel: getUserRoleLabel(m.roleIds ?? []),
        },
      ];
    });
  },
});

export const get = authQuery({
  args: { groupId: v.optional(v.string()) },
  returns: v.object({
    user: v.union(vUser, v.null()),
    groups: v.array(vGroup),
    selectedGroup: v.union(
      v.object({
        groupId: v.string(),
        name: v.string(),
        roleIds: v.array(v.string()),
        grants: v.array(v.string()),
        userRoleLabel: v.string(),
        projects: v.array(vProject),
        members: v.array(vMember),
        permissions: vPermissions,
      }),
      v.null(),
    ),
  }),
  handler: async (ctx, args) => {
    const userId = ctx.auth.userId;
    const roots = await auth.group.list(ctx, {
      where: { isRoot: true },
      orderBy: "name",
      order: "asc",
      paginationOpts: { numItems: 20, cursor: null },
    });

    const rootGroupIds = roots.page.map((g) => g._id);
    const resolutions = await auth.member.get(ctx, { userId, groupIds: rootGroupIds });

    const groups: GroupRow[] = roots.page.flatMap((g, i) => {
      const r = resolutions[i];
      if (!r || r.membership === null) return [];
      return [{ groupId: g._id, name: g.name, roleIds: r.roleIds, grants: r.grants }];
    });

    const user = {
      userId,
      name: ctx.auth.user.name ?? ctx.auth.user.email ?? "Unknown user",
      email: ctx.auth.user.email ?? null,
    };

    if (groups.length === 0) {
      return { user, groups: [], selectedGroup: null };
    }

    const selected = groups.find((g) => g.groupId === args.groupId) ?? groups[0]!;
    const permissions = getPermissions(selected.grants);

    const [projects, members] = await Promise.all([
      permissions.canReadProjects
        ? ctx.db
            .query("projects")
            .withIndex("by_groupId", (q) => q.eq("groupId", selected.groupId))
            .take(50)
        : Promise.resolve([]),
      auth.member.list(ctx, {
        where: { groupId: selected.groupId },
        paginationOpts: { numItems: 20, cursor: null },
        orderBy: "_creationTime",
        order: "asc",
      }),
    ]);

    const memberUserIds: readonly string[] = members.page.map((m) => m.userId);
    const memberUsers = await auth.user.get(ctx, { ids: memberUserIds });

    return {
      user,
      groups,
      selectedGroup: {
        groupId: selected.groupId,
        name: selected.name,
        roleIds: selected.roleIds,
        grants: selected.grants,
        userRoleLabel: getUserRoleLabel(selected.roleIds),
        projects: projects.map((p) => ({
          projectId: p._id,
          name: p.name,
          identifier: p.identifier,
          slug: p.slug,
          description: p.description,
          status: p.status,
          issueCount: p.issueCounter,
          openIssueCount: p.openIssueCount ?? 0,
        })),
        members: members.page.map((m, i) => {
          const u = memberUsers[i];
          return {
            memberId: m._id,
            userId: m.userId,
            name: u?.name ?? u?.email ?? "Unknown user",
            email: u?.email ?? null,
            roleIds: m.roleIds ?? [],
            status: m.status ?? "active",
          };
        }),
        permissions,
      },
    };
  },
});

export const listInvites = authQuery({
  args: { groupId: v.string() },
  returns: v.array(vInvite),
  handler: async (ctx, args) => {
    const userId = ctx.auth.userId;
    await auth.member.assert(ctx, {
      userId,
      groupId: args.groupId,
      grants: ["members.manage"],
    });
    const result = await auth.invite.list(ctx, {
      where: { groupId: args.groupId, status: "pending" },
      orderBy: "_creationTime",
      order: "desc",
      paginationOpts: { numItems: 20, cursor: null },
    });
    return result.page.map((inv) => ({
      inviteId: inv._id,
      email: inv.email ?? null,
      roleIds: inv.roleIds ?? [],
      createdAt: inv._creationTime,
    }));
  },
});

export const create = authMutation({
  args: { name: v.string() },
  returns: v.object({ groupId: v.string() }),
  handler: async (ctx, { name: rawName }) => {
    const name = rawName.trim();
    if (name.length < 3) {
      throw new ConvexError({
        code: ErrorCode.INVALID_INPUT,
        message: "Name must be at least 3 characters.",
      });
    }
    const userId = ctx.auth.userId;
    const groupId = await auth.group.create(ctx, { data: { name, slug: toSlug(name) } });
    await auth.member.create(ctx, {
      data: { userId, groupId, roleIds: [validRoleIds[0]] },
    });
    return { groupId };
  },
});

export const acceptInvite = authMutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = ctx.auth.userId;
    await auth.invite.token.accept(ctx, { token: args.token, acceptedByUserId: userId });
    return null;
  },
});

export const updateMemberRole = authMutation({
  args: {
    groupId: v.string(),
    memberId: v.string(),
    roleId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = ctx.auth.userId;
    await auth.member.assert(ctx, {
      userId,
      groupId: args.groupId,
      grants: ["members.manage"],
    });
    const matched = validRoleIds.find((id) => id === args.roleId);
    if (!matched) {
      throw new ConvexError({ code: ErrorCode.INVALID_INPUT, message: "Invalid role." });
    }
    if (matched !== validRoleIds[0]) {
      const members = await auth.member.list(ctx, {
        where: { groupId: args.groupId },
        paginationOpts: { numItems: 50, cursor: null },
      });
      const adminCount = members.page.filter(
        (m) => m.roleIds?.includes(validRoleIds[0]) && m._id !== args.memberId,
      ).length;
      if (adminCount === 0) {
        throw new ConvexError({
          code: ErrorCode.INVALID_INPUT,
          message: "Cannot remove the last admin.",
        });
      }
    }
    await auth.member.update(ctx, { id: args.memberId, patch: { roleIds: [matched] } });
    return null;
  },
});

export const revokeInvite = authMutation({
  args: { groupId: v.string(), inviteId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = ctx.auth.userId;
    await auth.member.assert(ctx, {
      userId,
      groupId: args.groupId,
      grants: ["members.manage"],
    });
    await auth.invite.revoke(ctx, { id: args.inviteId });
    return null;
  },
});

export const createInviteInternal = internalMutation({
  args: {
    groupId: v.string(),
    email: v.string(),
    roleId: v.string(),
    invitedByUserId: v.string(),
  },
  returns: v.object({ inviteId: v.string(), token: v.string() }),
  handler: async (ctx, args) => {
    await auth.member.assert(ctx, {
      userId: args.invitedByUserId,
      groupId: args.groupId,
      grants: ["members.manage"],
    });
    const matched = validRoleIds.find((id) => id === args.roleId);
    if (!matched) {
      throw new ConvexError({ code: ErrorCode.INVALID_INPUT, message: "Invalid role." });
    }
    const result = await auth.invite.create(ctx, {
      data: {
        groupId: args.groupId,
        email: args.email,
        roleIds: [matched],
        invitedByUserId: args.invitedByUserId,
      },
    });
    return { inviteId: result.id, token: result.token };
  },
});

export const inviteMember = authAction({
  args: {
    groupId: v.string(),
    email: v.string(),
    roleId: v.string(),
  },
  returns: v.object({ inviteId: v.string() }),
  handler: async (ctx, args) => {
    const userId = ctx.auth.userId;
    const email = args.email.trim().toLowerCase();
    const result: { inviteId: string; token: string } = await ctx.runMutation(
      internal.groups.createInviteInternal,
      { groupId: args.groupId, email, roleId: args.roleId, invitedByUserId: userId },
    );

    const appUrl = env.APP_URL ?? "http://localhost:3001";
    const inviteLink = `${appUrl}/?invite=${result.token}&email=${encodeURIComponent(email)}`;
    const from = env.AUTH_EMAIL ?? "My App <onboarding@resend.dev>";

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: email,
          subject: "You've been invited to an organization",
          html: `<p>You've been invited to join an organization.</p><p><a href="${inviteLink}">Accept invitation</a></p>`,
        }),
      });
      if (!res.ok) console.error("Invite email failed:", res.status);
    } catch (error) {
      console.error("Invite email error:", error);
    }

    return { inviteId: result.inviteId };
  },
});
