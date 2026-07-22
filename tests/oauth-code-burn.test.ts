import { components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { ErrorCode } from "@robelest/convex-auth/shared/codes";
import { ConvexError } from "convex/values";
import { expect, test } from "vite-plus/test";

import { convexTest } from "./convex/setup";

// Drives the REAL component `oauth.code` flow (mint via `oauth.code.create`,
// the mutation the `auth.oauth.authorize` facade wraps — then `oauth.code.accept`)
// end to end. The token-endpoint unit test in `oauth-idp.node.test.ts` mocks
// `acceptCode`; this pins the actual single-use burn and binding checks that
// live in the component mutation.

const CLIENT_ID = "oc_burn_test";
const REDIRECT = "https://app.example.com/cb";
const CHALLENGE = "s256-code-challenge-abcdef";

async function makeUser(t: ReturnType<typeof convexTest>, email: string) {
  return await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.user.create, { data: { email } });
  });
}

async function mintCode(
  t: ReturnType<typeof convexTest>,
  opts: { userId: string; codeHash: string; expiresAt: number },
) {
  await t.run(async (ctx) => {
    await ctx.runMutation(components.auth.oauth.code.create, {
      codeHash: opts.codeHash,
      userId: opts.userId as never,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      scopes: ["workspace:read"],
      codeChallenge: CHALLENGE,
      expiresAt: opts.expiresAt,
    });
  });
}

test("oauth.code.accept burns the code on first use and rejects the replay", async () => {
  const t = convexTest(schema);
  const userId = await makeUser(t, "code-burn@example.com");
  const codeHash = "burn-hash-single-use";
  await mintCode(t, { userId, codeHash, expiresAt: Date.now() + 60_000 });

  // First accept succeeds and stamps `usedAt` (the burn).
  const firstUsedAt = await t.run(async (ctx) => {
    const doc = await ctx.runMutation(components.auth.oauth.code.accept, {
      codeHash,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
    });
    return doc?.usedAt ?? null;
  });
  expect(typeof firstUsedAt).toBe("number");

  // Replaying the same code hash with identical bindings must throw — the
  // single-use guarantee. (Return nothing serializable from the throwing run.)
  await expect(
    t.run(async (ctx) => {
      await ctx.runMutation(components.auth.oauth.code.accept, {
        codeHash,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT,
        codeChallenge: CHALLENGE,
      });
    }),
  ).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof ConvexError &&
      (error.data as { code?: string })?.code === ErrorCode.OAUTH_CODE_ALREADY_USED,
  );
});

test("oauth.code.accept does not burn the code when a PKCE binding check fails", async () => {
  const t = convexTest(schema);
  const userId = await makeUser(t, "code-noburn@example.com");
  const codeHash = "burn-hash-binding";
  await mintCode(t, { userId, codeHash, expiresAt: Date.now() + 60_000 });

  // A wrong PKCE challenge returns null WITHOUT consuming the code, so a bad
  // `code_verifier` attempt cannot burn a legitimate pending code.
  const rejected = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.code.accept, {
      codeHash,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      codeChallenge: "wrong-code-challenge",
    });
  });
  expect(rejected).toBeNull();

  // The genuine accept still succeeds because the code was never burned.
  const usedAt = await t.run(async (ctx) => {
    const doc = await ctx.runMutation(components.auth.oauth.code.accept, {
      codeHash,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
    });
    return doc?.usedAt ?? null;
  });
  expect(typeof usedAt).toBe("number");
});
