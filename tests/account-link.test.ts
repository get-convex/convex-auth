import { components } from "@convex/_generated/api";
import { auth as backendAuth } from "@convex/auth";
import schema from "@convex/schema";
import { ErrorCode } from "@robelest/convex-auth/shared/codes";
import { ConvexError } from "convex/values";
import { expect, test } from "vite-plus/test";

import { convexTest } from "./convex/setup";

// `account.link` attaches a provider account to the signed-in user. Two
// boundaries must hold: re-linking the same (provider, account) to the same
// user is idempotent, and linking an account already owned by a DIFFERENT user
// is refused with ACCOUNT_ALREADY_LINKED (no silent account takeover).

async function makeUser(t: ReturnType<typeof convexTest>, email: string): Promise<string> {
  return await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.user.create, { data: { email } });
  });
}

test("account.link is idempotent when the same user re-links the same provider account", async () => {
  const t = convexTest(schema);
  const userId = await makeUser(t, "link-idempotent@example.com");

  const first = await t.withIdentity({ subject: userId, sid: "s1" } as any).run(async (ctx) => {
    return await backendAuth.account.link(ctx as any, {
      provider: "google",
      profile: { id: "google-sub-idem" },
    });
  });
  expect(first.alreadyLinked).toBe(false);
  expect(first.userId).toBe(userId);

  const second = await t.withIdentity({ subject: userId, sid: "s1" } as any).run(async (ctx) => {
    return await backendAuth.account.link(ctx as any, {
      provider: "google",
      profile: { id: "google-sub-idem" },
    });
  });
  expect(second.alreadyLinked).toBe(true);
  expect(second.accountId).toBe(first.accountId);
});

test("account.link refuses a provider account already owned by another user", async () => {
  const t = convexTest(schema);
  const userA = await makeUser(t, "owner@example.com");
  const userB = await makeUser(t, "intruder@example.com");

  // User A claims the provider account.
  await t.withIdentity({ subject: userA, sid: "sa" } as any).run(async (ctx) => {
    await backendAuth.account.link(ctx as any, {
      provider: "github",
      profile: { id: "github-shared-id" },
    });
  });

  // User B trying to link the same (provider, account) is rejected.
  await expect(
    t.withIdentity({ subject: userB, sid: "sb" } as any).run(async (ctx) => {
      await backendAuth.account.link(ctx as any, {
        provider: "github",
        profile: { id: "github-shared-id" },
      });
    }),
  ).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof ConvexError &&
      (error.data as { code?: string })?.code === ErrorCode.ACCOUNT_ALREADY_LINKED,
  );
});
