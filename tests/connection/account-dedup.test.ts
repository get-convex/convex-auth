/**
 * Regression: SSO provisioning must keep at most one Account per
 * (provider, providerAccountId) (concurrency cluster, item 1).
 *
 * The SCIM POST handler (`server/connection/http.ts` `handleUsersPost`) resolves
 * an already-provisioned user via `account.get({ provider, providerAccountId })`
 * and dedups the Account insert, so a retried or racing POST cannot create a
 * second Account under the same provider key. This suite pins the invariant that
 * handler relies on: the (provider, providerAccountId) lookup resolves a single
 * Account, and a duplicate breaks that lookup — the exact permanent SSO-login
 * lockout the dedup prevents (`account.get(...).unique()` throws).
 *
 * The handler itself runs in the SCIM HTTP action (bearer auth + routing), which
 * is exercised by the Docker interop suite; here we lock in the component-level
 * mechanism that makes the handler's dedup correct.
 */

import { components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { expect, test } from "vite-plus/test";

import { convexTest } from "../convex/setup";

const PROVIDER = "connection:oidc:conn-1";
const PROVIDER_ACCOUNT_ID = "okta-user-001";

test("account.get resolves a single Account by (provider, providerAccountId)", async () => {
  const t = convexTest(schema);

  const { userId, accountId } = await t.run(async (ctx) => {
    const userId = (await ctx.runMutation(components.auth.user.create, {
      data: { email: "sso@example.com" },
    })) as string;
    const accountId = (await ctx.runMutation(components.auth.account.create, {
      userId: userId as never,
      provider: PROVIDER,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    })) as string;
    return { userId, accountId };
  });

  const resolved = (await t.run((ctx) =>
    ctx.runQuery(components.auth.account.get, {
      provider: PROVIDER,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    }),
  )) as { _id: string; userId: string } | null;

  expect(resolved?._id).toBe(accountId);
  expect(resolved?.userId).toBe(userId);
});

test("account.create dedups the (provider, providerAccountId) identity so no duplicate can lock out account.get", async () => {
  const t = convexTest(schema);

  const { first, accountId } = await t.run(async (ctx) => {
    const first = (await ctx.runMutation(components.auth.user.create, {
      data: { email: "dup-a@example.com" },
    })) as string;
    const accountId = (await ctx.runMutation(components.auth.account.create, {
      userId: first as never,
      provider: PROVIDER,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    })) as string;
    return { first, accountId };
  });

  // A racing/retried create for the same identity but a DIFFERENT user is
  // rejected rather than writing the duplicate that would later brick
  // account.get(...).unique() — the permanent SSO/passkey lockout.
  await expect(
    t.run(async (ctx) => {
      const second = (await ctx.runMutation(components.auth.user.create, {
        data: { email: "dup-b@example.com" },
      })) as string;
      await ctx.runMutation(components.auth.account.create, {
        userId: second as never,
        provider: PROVIDER,
        providerAccountId: PROVIDER_ACCOUNT_ID,
      });
    }),
  ).rejects.toThrow("ACCOUNT_ALREADY_LINKED");

  // A retry for the SAME user is idempotent — it returns the existing account,
  // never a second row.
  const retried = (await t.run((ctx) =>
    ctx.runMutation(components.auth.account.create, {
      userId: first as never,
      provider: PROVIDER,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    }),
  )) as string;
  expect(retried).toBe(accountId);

  // The lookup the SSO/passkey flows rely on still resolves a single Account.
  const resolved = (await t.run((ctx) =>
    ctx.runQuery(components.auth.account.get, {
      provider: PROVIDER,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    }),
  )) as { _id: string; userId: string } | null;
  expect(resolved?._id).toBe(accountId);
  expect(resolved?.userId).toBe(first);
});
