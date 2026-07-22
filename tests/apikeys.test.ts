import { components } from "@convex/_generated/api";
import { auth } from "@convex/auth";
import schema from "@convex/schema";
import { ConvexError } from "convex/values";
import { expect, test, vi } from "vite-plus/test";

import { convexTest } from "./convex/setup";

/** Unwrap a key.get result, asserting non-null and returning the key doc. */
function expectKey(result: any) {
  expect(result).not.toBeNull();
  return result!;
}

/** Create a test user and return their userId. */
async function createUser(t: any, email = "test@example.com") {
  return await t.run(async (ctx: any) => {
    return await ctx.runMutation(components.auth.user.create, {
      data: { email, emailVerificationTime: Date.now() },
    });
  });
}

/** Inject a component mutation after key.verify's hash lookup but before recordUse. */
async function verifyAfterInterveningMutation(
  t: any,
  secret: string,
  intervene: (ctx: any) => Promise<void>,
  project: (verified: any) => any = (verified) => verified,
) {
  return await t.run(async (ctx: any) => {
    let intervened = false;
    const verificationCtx = {
      runQuery: ctx.runQuery.bind(ctx),
      runMutation: async (reference: any, args: any) => {
        if (!intervened) {
          intervened = true;
          await intervene(ctx);
        }
        return await ctx.runMutation(reference, args);
      },
    };
    return project(await auth.key.verify(verificationCtx as any, { secret }));
  });
}

test("key.create returns secret starting with sk_", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const result = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "CI Pipeline",
        scopes: [],
      },
    });
  });

  expect(result.secret).toMatch(/^sk_/);
  expect(result.id).toBeTruthy();
});

test("key.create and key.revoke emit audit events", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t, "key-audit@example.com");

  const { id: keyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: { userId, name: "Audit Key", scopes: [] },
    });
  });
  await t.run(async (ctx) => {
    return await auth.key.revoke(ctx, { id: keyId });
  });

  const events = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.event.list, {
      where: { subject: { type: "user", id: userId } },
      paginationOpts: { numItems: 10, cursor: null },
    });
  });
  const kinds = (events.page as Array<{ kind: string }>).map((event) => event.kind);
  expect(kinds).toContain("api_key.created");
  expect(kinds).toContain("api_key.revoked");
});

test("key.create with no scopes succeeds", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const result = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "No Scopes Key",
        scopes: [],
      },
    });
  });

  expect(result.secret).toBeTruthy();
  expect(result.id).toBeTruthy();
});

test("key.create with freeform scopes stores them as-is", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const scopes = [
    { resource: "data", actions: ["read", "write"] },
    { resource: "admin", actions: ["*"] },
  ];

  const { id: keyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Scoped Key",
        scopes,
      },
    });
  });

  const result = await t.run(async (ctx) => {
    return await auth.key.get(ctx, { id: keyId });
  });

  expect(expectKey(result).scopes).toEqual(scopes);
});

test("key.create with expiry stores expiresAt", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

  const { id: keyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Expiring Key",
        scopes: [],
        expiresAt,
      },
    });
  });

  const expiryResult = await t.run(async (ctx) => {
    return await auth.key.get(ctx, { id: keyId });
  });

  expect(expectKey(expiryResult).expiresAt).toBe(expiresAt);
});

test("key.create with per-key rateLimit stores it", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);
  const rateLimit = { maxRequests: 100, windowMs: 60_000 };

  const { id: keyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Rate Limited Key",
        scopes: [],
        rateLimit,
      },
    });
  });

  const rateResult = await t.run(async (ctx) => {
    return await auth.key.get(ctx, { id: keyId });
  });

  expect(expectKey(rateResult).rateLimit).toEqual(rateLimit);
});

test("key.create rejects malformed rate limits", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);
  const invalidRateLimits = [
    { maxRequests: 0, windowMs: 60_000 },
    { maxRequests: -1, windowMs: 60_000 },
    { maxRequests: 1.5, windowMs: 60_000 },
    { maxRequests: Number.NaN, windowMs: 60_000 },
    { maxRequests: 1, windowMs: 0 },
    { maxRequests: 1, windowMs: Number.POSITIVE_INFINITY },
  ];

  for (const rateLimit of invalidRateLimits) {
    await expect(
      t.run(async (ctx) => {
        return await auth.key.create(ctx, {
          data: { userId, name: "Invalid Limit", scopes: [], rateLimit },
        });
      }),
    ).rejects.toThrow("positive integer maxRequests");
  }
});

test("key.update rejects malformed rate limits and preserves the previous limit", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);
  const original = { maxRequests: 10, windowMs: 60_000 };
  const { id: keyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: { userId, name: "Valid Limit", scopes: [], rateLimit: original },
    });
  });

  await expect(
    t.run(async (ctx) => {
      return await auth.key.update(ctx, {
        id: keyId,
        patch: { rateLimit: { maxRequests: 0, windowMs: 60_000 } },
      });
    }),
  ).rejects.toThrow("positive integer maxRequests");

  const key = await t.run(async (ctx) => auth.key.get(ctx, { id: keyId }));
  expect(expectKey(key).rateLimit).toEqual(original);
});

test("key.verify with valid secret returns userId keyId and scopes", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);
  const scopes = [{ resource: "data", actions: ["read"] }];

  const { secret, id: keyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: { userId, name: "Test Key", scopes },
    });
  });

  const result = await t.run(async (ctx) => {
    const verified = await auth.key.verify(ctx, { secret: secret });
    return {
      userId: verified.userId,
      keyId: verified.keyId,
      canDataRead: verified.scopes.can("data", "read"),
      canDataWrite: verified.scopes.can("data", "write"),
    };
  });

  expect(result.userId).toBe(userId);
  expect(result.keyId).toBe(keyId);
  expect(result.canDataRead).toBe(true);
  expect(result.canDataWrite).toBe(false);
});

test("key.verify with unknown key throws ConvexError", async () => {
  const t = convexTest(schema);

  await expect(
    t.run(async (ctx) => {
      return await auth.key.verify(ctx, { secret: "sk_not_a_real_key_abc123" });
    }),
  ).rejects.toThrow(ConvexError);
});

test("key.verify after revoke throws ConvexError", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { secret, id: keyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Revokable",
        scopes: [],
      },
    });
  });

  await t.run(async (ctx) => {
    await auth.key.revoke(ctx, { id: keyId });
  });

  await expect(
    t.run(async (ctx) => {
      return await auth.key.verify(ctx, { secret: secret });
    }),
  ).rejects.toThrow(ConvexError);
});

test("key.verify after expiry throws ConvexError", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema);
  const userId = await createUser(t);
  const expiresAt = Date.now() + 1000;

  const { secret } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Short-lived Key",
        scopes: [],
        expiresAt,
      },
    });
  });

  vi.advanceTimersByTime(2000);

  await expect(
    t.run(async (ctx) => {
      return await auth.key.verify(ctx, { secret: secret });
    }),
  ).rejects.toThrow(ConvexError);

  vi.useRealTimers();
});

test("key usage transaction does not trust a caller-supplied timestamp", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(10_000);
    const t = convexTest(schema);
    const userId = await createUser(t);
    const { id: keyId } = await t.run(async (ctx) => {
      return await auth.key.create(ctx, {
        data: {
          userId,
          name: "Expired Timestamp",
          scopes: [],
          expiresAt: 9_999,
        },
      });
    });

    const result = await t.run(async (ctx) => {
      return await ctx.runMutation((components.auth.user.key as any).recordUse, {
        id: keyId,
        now: 0,
        coarsenMs: 60_000,
      });
    });

    expect(result).toEqual({ status: "expired" });
  } finally {
    vi.useRealTimers();
  }
});

test("key.verify rejects a key deleted after its hash lookup", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);
  const { secret, id: keyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: { userId, name: "Delete Race", scopes: [] },
    });
  });

  await expect(
    verifyAfterInterveningMutation(t, secret, async (ctx) => {
      await ctx.runMutation(components.auth.user.key.remove, { id: keyId });
    }),
  ).rejects.toThrow("Invalid API key");
});

test("key.verify rejects a key revoked after its hash lookup", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);
  const { secret, id: keyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: { userId, name: "Revoke Race", scopes: [] },
    });
  });

  await expect(
    verifyAfterInterveningMutation(t, secret, async (ctx) => {
      await ctx.runMutation(components.auth.user.key.update, {
        id: keyId,
        patch: { revoked: true },
      });
    }),
  ).rejects.toThrow("revoked");
});

test("key.verify returns scopes current at the usage transaction", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);
  const { secret, id: keyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Scope Race",
        scopes: [{ resource: "data", actions: ["read", "write"] }],
      },
    });
  });

  const permissions = await verifyAfterInterveningMutation(
    t,
    secret,
    async (ctx) => {
      await ctx.runMutation(components.auth.user.key.update, {
        id: keyId,
        patch: { scopes: [{ resource: "data", actions: ["read"] }] },
      });
    },
    (verified) => ({
      canRead: verified.scopes.can("data", "read"),
      canWrite: verified.scopes.can("data", "write"),
    }),
  );

  expect(permissions.canRead).toBe(true);
  expect(permissions.canWrite).toBe(false);
});

test("key.verify rate limiting triggers after threshold", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { secret } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Rate Limited",
        scopes: [],
        rateLimit: { maxRequests: 3, windowMs: 60_000 },
      },
    });
  });

  for (let i = 0; i < 3; i++) {
    await t.run(async (ctx) => {
      const verified = await auth.key.verify(ctx, { secret: secret });
      return verified.userId;
    });
  }

  await expect(
    t.run(async (ctx) => {
      return await auth.key.verify(ctx, { secret: secret });
    }),
  ).rejects.toThrow(ConvexError);

  vi.useRealTimers();
});

test("key.verify fails closed on malformed legacy bucket state", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);
  const { id: keyId, secret } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Malformed Bucket",
        scopes: [],
        rateLimit: { maxRequests: 10, windowMs: 60_000 },
      },
    });
  });
  await t.run(async (ctx) => {
    await ctx.runMutation(components.auth.user.key.update, {
      id: keyId,
      patch: {
        rateLimitState: {
          attemptsLeft: Number.NaN,
          lastAttemptTime: Date.now(),
        },
      },
    });
  });

  await expect(t.run(async (ctx) => auth.key.verify(ctx, { secret }))).rejects.toThrow(
    "rate limit exceeded",
  );
});

test("key.list returns only keys for the given userId", async () => {
  const t = convexTest(schema);
  const userId1 = await createUser(t, "user1@example.com");
  const userId2 = await createUser(t, "user2@example.com");

  await t.run(async (ctx) => {
    await auth.key.create(ctx, {
      data: { userId: userId1, name: "Key A", scopes: [] },
    });
    await auth.key.create(ctx, {
      data: { userId: userId1, name: "Key B", scopes: [] },
    });
    await auth.key.create(ctx, {
      data: { userId: userId2, name: "Key C", scopes: [] },
    });
  });

  const result = await t.run(async (ctx) => {
    return await auth.key.list(ctx, {
      where: { userId: userId1 },
      paginationOpts: { numItems: 50, cursor: null },
    });
  });

  expect(result.page).toHaveLength(2);
  expect(result.page.every((k: any) => k.userId === userId1)).toBe(true);
});

test("key.list with revoked: false excludes revoked keys", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { id: keyId } = await t.run(async (ctx) => {
    await auth.key.create(ctx, {
      data: { userId, name: "Active Key", scopes: [] },
    });
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "To Revoke",
        scopes: [],
      },
    });
  });

  await t.run(async (ctx) => {
    await auth.key.revoke(ctx, { id: keyId });
  });

  const result = await t.run(async (ctx) => {
    return await auth.key.list(ctx, {
      where: { userId, revoked: false },
      paginationOpts: { numItems: 50, cursor: null },
    });
  });

  expect(result.page).toHaveLength(1);
  expect(result.page[0].name).toBe("Active Key");
});

test("key.get returns record without secret", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { id: keyId, secret } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: { userId, name: "Get Test", scopes: [] },
    });
  });

  const getResult = await t.run(async (ctx) => {
    return await auth.key.get(ctx, { id: keyId });
  });

  const record = expectKey(getResult);
  expect(record._id).toBe(keyId);
  expect(record.userId).toBe(userId);
  expect(record.name).toBe("Get Test");
  expect(record.prefix).toMatch(/^sk_/);
  expect(JSON.stringify(record)).not.toContain(secret);
});

test("key.get after revoke still returns record with revoked: true", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { id: keyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Revoke Check",
        scopes: [],
      },
    });
  });

  await t.run(async (ctx) => {
    await auth.key.revoke(ctx, { id: keyId });
  });

  const revokeResult = await t.run(async (ctx) => {
    return await auth.key.get(ctx, { id: keyId });
  });

  expect(expectKey(revokeResult).revoked).toBe(true);
});

test("key.revoke sets revoked flag and verify throws ConvexError", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { secret, id: keyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "To Revoke",
        scopes: [],
      },
    });
  });

  await t.run(async (ctx) => {
    await auth.key.revoke(ctx, { id: keyId });
  });

  const revokedGet = await t.run(async (ctx) => {
    return await auth.key.get(ctx, { id: keyId });
  });

  expect(expectKey(revokedGet).revoked).toBe(true);

  await expect(
    t.run(async (ctx) => {
      return await auth.key.verify(ctx, { secret: secret });
    }),
  ).rejects.toThrow(ConvexError);
});

test("scopes.can returns true for exact resource and action match", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { secret } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Scoped",
        scopes: [{ resource: "reports", actions: ["read", "export"] }],
      },
    });
  });

  const checks = await t.run(async (ctx) => {
    const verified = await auth.key.verify(ctx, { secret: secret });
    return {
      reportsRead: verified.scopes.can("reports", "read"),
      reportsExport: verified.scopes.can("reports", "export"),
      reportsDelete: verified.scopes.can("reports", "delete"),
      usersRead: verified.scopes.can("users", "read"),
    };
  });

  expect(checks.reportsRead).toBe(true);
  expect(checks.reportsExport).toBe(true);
  expect(checks.reportsDelete).toBe(false);
  expect(checks.usersRead).toBe(false);
});

test("scopes.can wildcard action grants all actions on resource", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { secret } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Wildcard Action",
        scopes: [{ resource: "data", actions: ["*"] }],
      },
    });
  });

  const checks = await t.run(async (ctx) => {
    const verified = await auth.key.verify(ctx, { secret: secret });
    return {
      dataRead: verified.scopes.can("data", "read"),
      dataWrite: verified.scopes.can("data", "write"),
      dataDelete: verified.scopes.can("data", "delete"),
      adminRead: verified.scopes.can("admin", "read"),
    };
  });

  expect(checks.dataRead).toBe(true);
  expect(checks.dataWrite).toBe(true);
  expect(checks.dataDelete).toBe(true);
  expect(checks.adminRead).toBe(false);
});

test("scopes.can wildcard resource grants action on all resources", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { secret } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Wildcard Resource",
        scopes: [{ resource: "*", actions: ["read"] }],
      },
    });
  });

  const checks = await t.run(async (ctx) => {
    const verified = await auth.key.verify(ctx, { secret: secret });
    return {
      dataRead: verified.scopes.can("data", "read"),
      usersRead: verified.scopes.can("users", "read"),
      adminRead: verified.scopes.can("admin", "read"),
      dataWrite: verified.scopes.can("data", "write"),
    };
  });

  expect(checks.dataRead).toBe(true);
  expect(checks.usersRead).toBe(true);
  expect(checks.adminRead).toBe(true);
  expect(checks.dataWrite).toBe(false);
});

test("scopes.can full wildcard grants everything", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { secret } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Full Access",
        scopes: [{ resource: "*", actions: ["*"] }],
      },
    });
  });

  const checks = await t.run(async (ctx) => {
    const verified = await auth.key.verify(ctx, { secret: secret });
    return {
      anythingAnything: verified.scopes.can("anything", "anything"),
      dataDelete: verified.scopes.can("data", "delete"),
      adminImpersonate: verified.scopes.can("admin", "impersonate"),
    };
  });

  expect(checks.anythingAnything).toBe(true);
  expect(checks.dataDelete).toBe(true);
  expect(checks.adminImpersonate).toBe(true);
});

test("auth.context returns auth state from a session identity", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const resolved = await t.run(async (ctx) => {
    const sessionCtx = {
      ...ctx,
      auth: {
        ...ctx.auth,
        getUserIdentity: async () => ({
          subject: userId,
          sid: "session_123",
          issuer: "https://example.com",
        }),
      },
    };
    const authContext = await auth.context(sessionCtx as any);
    return {
      userId: authContext.userId,
      groupId: authContext.groupId,
      role: authContext.role,
      grants: authContext.grants,
    };
  });

  expect(resolved).toEqual({
    userId,
    groupId: null,
    role: null,
    grants: [],
  });
});

test("auth.context optional returns null-shaped auth when unauthenticated", async () => {
  const t = convexTest(schema);

  const resolved = await t.run(async (ctx) => {
    const c = await auth.context.optional(ctx);
    return {
      userId: c.userId,
      user: c.user,
      groupId: c.groupId,
      role: c.role,
      grants: c.grants,
      assertType: typeof c.assert,
    };
  });

  expect(resolved).toEqual({
    userId: null,
    user: null,
    groupId: null,
    role: null,
    grants: [],
    assertType: "function",
  });
});

test("auth.request.context returns userId from API key Bearer header", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { secret } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Bearer Key",
        scopes: [],
      },
    });
  });

  const resolved = await t.run(async (ctx) => {
    const request = new Request("https://example.com/api/data", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const authContext = await auth.request.context(ctx, request);
    return {
      userId: authContext.userId,
      source: authContext.source,
      keyId: authContext.key?.keyId ?? null,
    };
  });

  expect(resolved).toEqual({
    userId,
    source: "key",
    keyId: expect.any(String),
  });
});

test("auth.request.context optional returns null-shaped auth with no session and no header", async () => {
  const t = convexTest(schema);

  const resolved = await t.run(async (ctx) => {
    const request = new Request("https://example.com/api/data");
    const c = await auth.request.context.optional(ctx, request);
    return {
      userId: c.userId,
      user: c.user,
      groupId: c.groupId,
      role: c.role,
      grants: c.grants,
      source: c.source,
      key: c.key,
      assertType: typeof c.assert,
    };
  });

  expect(resolved).toEqual({
    userId: null,
    user: null,
    groupId: null,
    role: null,
    grants: [],
    source: null,
    key: null,
    assertType: "function",
  });
});

test("auth.request.context optional returns null-shaped auth with invalid Bearer key", async () => {
  const t = convexTest(schema);

  const resolved = await t.run(async (ctx) => {
    const request = new Request("https://example.com/api/data", {
      headers: { Authorization: "Bearer sk_not_a_real_key" },
    });
    const c = await auth.request.context.optional(ctx, request);
    return {
      userId: c.userId,
      user: c.user,
      groupId: c.groupId,
      role: c.role,
      grants: c.grants,
      source: c.source,
      key: c.key,
      assertType: typeof c.assert,
    };
  });

  expect(resolved).toEqual({
    userId: null,
    user: null,
    groupId: null,
    role: null,
    grants: [],
    source: null,
    key: null,
    assertType: "function",
  });
});

test("auth.request.context optional returns null-shaped auth with revoked key", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { secret, id: keyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: { userId, name: "Revoked", scopes: [] },
    });
  });
  await t.run(async (ctx) => auth.key.revoke(ctx, { id: keyId }));

  const resolved = await t.run(async (ctx) => {
    const request = new Request("https://example.com/api/data", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const c = await auth.request.context.optional(ctx, request);
    return {
      userId: c.userId,
      user: c.user,
      groupId: c.groupId,
      role: c.role,
      grants: c.grants,
      source: c.source,
      key: c.key,
      assertType: typeof c.assert,
    };
  });

  expect(resolved).toEqual({
    userId: null,
    user: null,
    groupId: null,
    role: null,
    grants: [],
    source: null,
    key: null,
    assertType: "function",
  });
});

test("auth.request.context prefers session auth over API key when both are present", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { secret } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: { userId, name: "Fallback", scopes: [] },
    });
  });

  const resolved = await t.run(async (ctx) => {
    const sessionCtx = {
      ...ctx,
      auth: {
        ...ctx.auth,
        getUserIdentity: async () => ({
          subject: userId,
          sid: "session_456",
          issuer: "https://example.com",
        }),
      },
    };
    const request = new Request("https://example.com/api/data", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const authContext = await auth.request.context(sessionCtx as any, request);
    return {
      userId: authContext.userId,
      source: authContext.source,
      key: authContext.key,
    };
  });

  expect(resolved).toEqual({
    userId,
    source: "session",
    key: null,
  });
});

test("auth.request.context throws when required auth is missing", async () => {
  const t = convexTest(schema);

  await expect(
    t.run(async (ctx) => {
      const request = new Request("https://example.com/api/data");
      return await auth.request.context(ctx, request);
    }),
  ).rejects.toThrow(ConvexError);
});

test("key.rotate returns new secret starting with sk_", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { id: oldKeyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Rotate Me",
        scopes: [{ resource: "data", actions: ["read"] }],
      },
    });
  });

  const { id: newKeyId, secret } = await t.run(async (ctx) => {
    return await auth.key.rotate(ctx, { id: oldKeyId });
  });

  expect(secret).toMatch(/^sk_/);
  expect(newKeyId).not.toBe(oldKeyId);
});

test("key.rotate atomically permits only one concurrent replacement", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);
  const { id: oldKeyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Concurrent Rotate",
        scopes: [{ resource: "data", actions: ["read"] }],
      },
    });
  });

  const race = await t.run(async (ctx: any) => {
    let intervened = false;
    let winner: { id: string; secret: string } | null = null;
    const racingCtx = {
      runQuery: ctx.runQuery.bind(ctx),
      runMutation: async (reference: any, args: any) => {
        if (!intervened) {
          intervened = true;
          winner = await auth.key.rotate(ctx, { id: oldKeyId });
        }
        return await ctx.runMutation(reference, args);
      },
    };

    let loserError: string | null = null;
    try {
      await auth.key.rotate(racingCtx as any, { id: oldKeyId });
    } catch (error) {
      loserError = error instanceof Error ? error.message : String(error);
    }
    return {
      winner: winner as { id: string; secret: string } | null,
      loserError,
    };
  });

  expect(race.winner).not.toBeNull();
  expect(race.loserError).toContain("revoked");
  if (race.winner === null) {
    throw new Error("Expected one concurrent rotation to succeed");
  }
  const listed = await t.run(async (ctx) => {
    return await auth.key.list(ctx, {
      where: { userId },
      paginationOpts: { numItems: 10, cursor: null },
    });
  });
  expect(listed.page).toHaveLength(2);
  expect(listed.page.filter((key) => !key.revoked)).toHaveLength(1);

  const winnerSecret = race.winner.secret;
  const winnerId = await t.run(async (ctx) => {
    return (await auth.key.verify(ctx, { secret: winnerSecret })).keyId;
  });
  expect(winnerId).toBe(race.winner.id);
});

test("key.rotate: old key verify throws ConvexError after rotation", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { id: oldKeyId, secret: oldSecret } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "To Rotate",
        scopes: [],
      },
    });
  });

  await t.run(async (ctx) => auth.key.rotate(ctx, { id: oldKeyId }));

  await expect(t.run(async (ctx) => auth.key.verify(ctx, { secret: oldSecret }))).rejects.toThrow(
    ConvexError,
  );
});

test("key.rotate: new key verify succeeds with same userId", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { id: oldKeyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Rotate",
        scopes: [{ resource: "reports", actions: ["read"] }],
      },
    });
  });

  const { secret: newSecret } = await t.run(async (ctx) => {
    return await auth.key.rotate(ctx, { id: oldKeyId });
  });

  const result = await t.run(async (ctx) => {
    const verified = await auth.key.verify(ctx, { secret: newSecret });
    return {
      userId: verified.userId,
      canReportsRead: verified.scopes.can("reports", "read"),
    };
  });

  expect(result.userId).toBe(userId);
  expect(result.canReportsRead).toBe(true);
});

test("key.rotate: new key inherits scopes and rateLimit", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);
  const scopes = [{ resource: "data", actions: ["write"] }];
  const rateLimit = { maxRequests: 50, windowMs: 60_000 };

  const { id: oldKeyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Config Key",
        scopes,
        rateLimit,
      },
    });
  });

  const { id: newKeyId } = await t.run(async (ctx) => {
    return await auth.key.rotate(ctx, { id: oldKeyId });
  });

  const rotateGet = await t.run(async (ctx) => auth.key.get(ctx, { id: newKeyId }));

  const rotated = expectKey(rotateGet);
  expect(rotated.scopes).toEqual(scopes);
  expect(rotated.rateLimit).toEqual(rateLimit);
});

test("key.rotate emits api_key.revoked for the old key", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t, "rotate-audit@example.com");

  const { id: oldKeyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: { userId, name: "Rotate Audit", scopes: [] },
    });
  });

  await t.run(async (ctx) => auth.key.rotate(ctx, { id: oldKeyId }));

  const events = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.event.list, {
      where: { target: { kind: "api_key", id: oldKeyId } },
      paginationOpts: { numItems: 10, cursor: null },
    });
  });
  const kinds = (events.page as Array<{ kind: string }>).map((event) => event.kind);
  expect(kinds).toContain("api_key.revoked");
});

test("key.rotate: rotating already-revoked key throws ConvexError", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  const { id: keyId } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: { userId, name: "Revoked", scopes: [] },
    });
  });

  await t.run(async (ctx) => auth.key.revoke(ctx, { id: keyId }));

  await expect(t.run(async (ctx) => auth.key.rotate(ctx, { id: keyId }))).rejects.toThrow(
    ConvexError,
  );
});
