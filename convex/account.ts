import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import { auth } from "./auth/core";
import { ErrorCode } from "./errors";
import { authUserMutation, authUserQuery } from "./functions";

const vPasskey = v.object({
  passkeyId: v.string(),
  name: v.union(v.string(), v.null()),
  deviceType: v.string(),
  backedUp: v.boolean(),
  createdAt: v.number(),
  lastUsedAt: v.union(v.number(), v.null()),
});

const vApiKeyScope = v.object({
  resource: v.string(),
  actions: v.array(v.string()),
});

const vApiKey = v.object({
  keyId: v.string(),
  prefix: v.string(),
  name: v.string(),
  revoked: v.boolean(),
  createdAt: v.number(),
  lastUsedAt: v.union(v.number(), v.null()),
  scopes: v.array(vApiKeyScope),
});

type PasskeyListCtx = Parameters<typeof auth.account.passkey.list>[0];
type ApiKeyGetCtx = Parameters<typeof auth.key.get>[0];
type AccountDoc = { provider: string };

async function requireOwnedPasskey(ctx: PasskeyListCtx, userId: string, passkeyId: string) {
  const passkeys = await auth.account.passkey.list(ctx, { userId });
  const passkey = passkeys.find((item) => item._id === passkeyId);
  if (!passkey) {
    throw new ConvexError({
      code: ErrorCode.NOT_FOUND,
      message: "Passkey not found.",
    });
  }
  return passkey;
}

async function requireOwnedApiKey(ctx: ApiKeyGetCtx, userId: string, keyId: string) {
  const key = await auth.key.get(ctx, { id: keyId });
  if (!key || key.userId !== userId) {
    throw new ConvexError({
      code: ErrorCode.NOT_FOUND,
      message: "API key not found.",
    });
  }
  return key;
}

export const listPasskeys = authUserQuery({
  args: {},
  returns: v.array(vPasskey),
  handler: async (ctx) => {
    const userId = ctx.auth.userId;
    const passkeys = await auth.account.passkey.list(ctx, {
      userId,
    });
    return passkeys.map((passkey) => ({
      passkeyId: passkey._id,
      name: passkey.name ?? null,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt ?? null,
    }));
  },
});

export const renamePasskey = authUserMutation({
  args: { passkeyId: v.string(), name: v.string() },
  returns: v.object({ passkeyId: v.string() }),
  handler: async (ctx, args) => {
    const userId = ctx.auth.userId;
    await requireOwnedPasskey(ctx, userId, args.passkeyId);
    return await auth.account.passkey.update(ctx, {
      id: args.passkeyId,
      patch: { name: args.name.trim() },
    });
  },
});

export const removePasskey = authUserMutation({
  args: { passkeyId: v.string() },
  returns: v.object({ passkeyId: v.string() }),
  handler: async (ctx, args) => {
    const userId = ctx.auth.userId;
    await requireOwnedPasskey(ctx, userId, args.passkeyId);
    return await auth.account.passkey.remove(ctx, { id: args.passkeyId });
  },
});

export const listApiKeys = authUserQuery({
  args: {},
  returns: v.array(vApiKey),
  handler: async (ctx) => {
    const userId = ctx.auth.userId;
    const result = await auth.key.list(ctx, {
      where: { userId },
      paginationOpts: { numItems: 20, cursor: null },
      orderBy: "lastUsedAt",
      order: "desc",
    });
    return result.page.map((key) => ({
      keyId: key._id,
      prefix: key.prefix,
      name: key.name,
      revoked: key.revoked,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt ?? null,
      scopes: key.scopes,
    }));
  },
});

export const createApiKey = authUserMutation({
  args: {
    name: v.string(),
    issueRead: v.boolean(),
    issueWrite: v.boolean(),
  },
  returns: v.object({ keyId: v.string(), secret: v.string() }),
  handler: async (ctx, args) => {
    const userId = ctx.auth.userId;
    const scopeActions = [
      ...(args.issueRead ? ["read"] : []),
      ...(args.issueWrite ? ["write"] : []),
    ];
    const scopes = scopeActions.length === 0 ? [] : [{ resource: "issues", actions: scopeActions }];
    const result = await auth.key.create(ctx, {
      data: {
        userId,
        name: args.name.trim(),
        scopes,
      },
    });
    return { keyId: result.id, secret: result.secret };
  },
});

export const revokeApiKey = authUserMutation({
  args: { keyId: v.string() },
  returns: v.object({ keyId: v.string() }),
  handler: async (ctx, args) => {
    const userId = ctx.auth.userId;
    await requireOwnedApiKey(ctx, userId, args.keyId);
    await auth.key.revoke(ctx, { id: args.keyId });
    return { keyId: args.keyId };
  },
});

export const hasPassword = authUserQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const accounts: AccountDoc[] = await ctx.runQuery(components.auth.account.list, {
      userId: ctx.auth.userId,
    });
    return accounts.some((account) => account.provider === "password");
  },
});
