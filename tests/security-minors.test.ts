/**
 * Minor security-hardening regression tests (audit wave-4).
 *
 * Covers:
 *  - Finding 1: passkey `signIn` returns deterministic decoy `allowCredentials`
 *    for an unknown email, closing the account-enumeration oracle.
 *  - Finding 2: device-flow poll is rate-limited, and the authorized session is
 *    bound to the identity that approved it.
 *  - Finding 4: `auth.oauth.authorize` rejects a `userId` that is not the
 *    authenticated caller.
 *  - Finding 7: `auth.key.get` / `auth.key.list` omit `hashedKey` and
 *    `rateLimitState`.
 */

import { api, components } from "@convex/_generated/api";
import { auth } from "@convex/auth";
import schema from "@convex/schema";
import { decodeJwt } from "jose";
import { expect, test } from "vite-plus/test";

import { convexTest } from "./convex/setup";
import { expectSignInSession, TEST_EMAIL, TEST_PASSWORD } from "./helpers";

async function createVerifiedUser(t: ReturnType<typeof convexTest>, email: string) {
  return await t.run(async (ctx) => {
    return (await ctx.runMutation(components.auth.user.create, {
      data: { email, emailVerificationTime: Date.now() },
    })) as string;
  });
}

/** Pull the `allowCredentials` id list out of a passkey `signIn` result. */
function allowCredentialIds(result: { kind: string; options?: unknown }): string[] | undefined {
  if (result.kind !== "passkeyOptions") throw new Error("expected passkeyOptions");
  const options = result.options as {
    allowCredentials?: Array<{ id: string }>;
  };
  return options.allowCredentials?.map((c) => c.id);
}

// ── Finding 1: passkey account-enumeration decoys ────────────────────────────

test("passkey signIn returns deterministic decoy allowCredentials for an unknown email", async () => {
  const t = convexTest(schema);

  const first = allowCredentialIds(
    await t.action(api.auth.signIn, {
      provider: "passkey",
      params: { flow: "signIn", email: "ghost@example.com" },
    }),
  );
  // Unknown email still yields a non-empty allowCredentials list (decoys), so it
  // is indistinguishable from an account that owns passkeys.
  expect(first).toBeDefined();
  expect(first!.length).toBeGreaterThan(0);

  // Same email → same decoys (derived from a hash of the email).
  const second = allowCredentialIds(
    await t.action(api.auth.signIn, {
      provider: "passkey",
      params: { flow: "signIn", email: "ghost@example.com" },
    }),
  );
  expect(second).toEqual(first);

  // A different unknown email → different decoys.
  const other = allowCredentialIds(
    await t.action(api.auth.signIn, {
      provider: "passkey",
      params: { flow: "signIn", email: "someone-else@example.com" },
    }),
  );
  expect(other).not.toEqual(first);
});

test("passkey signIn returns the real credential for a known email (not a decoy)", async () => {
  const t = convexTest(schema);
  const userId = await createVerifiedUser(t, "known-passkey@example.com");
  await t.run(async (ctx) => {
    await ctx.runMutation(components.auth.factor.passkey.create, {
      userId: userId as never,
      credentialId: "real-credential-xyz",
      publicKey: new ArrayBuffer(32),
      algorithm: -7,
      counter: 0,
      deviceType: "multiDevice",
      backedUp: true,
      createdAt: Date.now(),
    });
  });

  const ids = allowCredentialIds(
    await t.action(api.auth.signIn, {
      provider: "passkey",
      params: { flow: "signIn", email: "known-passkey@example.com" },
    }),
  );
  expect(ids).toEqual(["real-credential-xyz"]);
});

// ── Finding 2: device flow rate limit + identity binding ─────────────────────

test("device poll is rate-limited after repeated misses on the same code", async () => {
  const t = convexTest(schema);
  let lastError: { data?: { code?: string }; message?: string } | null = null;
  for (let i = 0; i < 15; i++) {
    lastError = await t
      .action(api.auth.signIn, {
        provider: "device",
        params: { flow: "poll", deviceCode: "definitely-not-a-real-device-code" },
      })
      .then(() => null)
      .catch((e) => e);
  }
  expect(lastError).not.toBeNull();
  const code = lastError?.data?.code ?? lastError?.message ?? "";
  expect(String(code)).toMatch(/RATE_LIMITED/);
});

test("device verify binds the polled session to the authorizing user", async () => {
  const t = convexTest(schema);

  const signInTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      provider: "password",
      params: { email: TEST_EMAIL, password: TEST_PASSWORD, flow: "signUp" },
    }),
  );
  const claims = decodeJwt(signInTokens!.token);
  const authorizingUserId = claims.sub;
  const asUser = t.withIdentity({ subject: claims.sub, sid: claims.sid as never });

  const created = await t.action(api.auth.signIn, {
    provider: "device",
    params: { flow: "create" },
  });
  const { deviceCode, userCode } =
    created.kind === "deviceCode" ? created.deviceCode : { deviceCode: "", userCode: "" };
  expect(deviceCode).not.toEqual("");

  const verified = await asUser.action(api.auth.signIn, {
    provider: "device",
    params: { flow: "verify", userCode },
  });
  expect(verified.kind).toBe("signedIn");

  const pollTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      provider: "device",
      params: { flow: "poll", deviceCode },
    }),
  );
  const pollClaims = decodeJwt(pollTokens!.token);
  // The device's session belongs to the user who approved it — never anyone else.
  expect(pollClaims.sub).toBe(authorizingUserId);
});

// ── Finding 4: oauth.authorize must not trust the passed userId ──────────────

/**
 * Call `auth.oauth.authorize` with a mocked caller identity and return the
 * thrown `ConvexError` code (or "OK" if it unexpectedly resolved). The client is
 * intentionally unknown so a caller that passes the identity gate stops at the
 * client-grant check — letting the two failures be told apart by code.
 */
async function authorizeCode(
  t: ReturnType<typeof convexTest>,
  subject: string | null,
  userId: string,
): Promise<string> {
  return await t
    .run(async (ctx) => {
      const callerCtx = {
        ...ctx,
        auth: {
          ...ctx.auth,
          getUserIdentity: async () => (subject === null ? null : { subject }),
        },
      };
      await auth.oauth.authorize(callerCtx as never, {
        userId,
        clientId: "nonexistent-oauth-client",
        scopes: [],
        redirectUri: "https://app.example/callback",
        codeChallenge: "challenge",
      });
      return { code: "OK" };
    })
    .then(() => "OK")
    .catch((e: { data?: { code?: string } }) => e?.data?.code ?? "THROW");
}

test("oauth.authorize rejects a userId that is not the authenticated caller", async () => {
  const t = convexTest(schema);
  // Mismatch: caller is user-a, but the request claims user-b → NOT_AUTHORIZED.
  expect(await authorizeCode(t, "user-a", "user-b")).toBe("NOT_AUTHORIZED");
  // Unauthenticated caller → NOT_AUTHORIZED.
  expect(await authorizeCode(t, null, "user-a")).toBe("NOT_AUTHORIZED");
  // Matching caller passes the identity gate and only then fails on the unknown
  // client — proving the gate is what rejected the mismatched cases above.
  expect(await authorizeCode(t, "user-a", "user-a")).toBe("OAUTH_CLIENT_NOT_FOUND");
});

// ── Finding 7: key.get / key.list redaction ──────────────────────────────────

test("auth.key.get and auth.key.list omit hashedKey and rateLimitState", async () => {
  const t = convexTest(schema);
  const userId = await createVerifiedUser(t, "key-redaction@example.com");

  const { id: keyId, secret } = await t.run(async (ctx) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Redacted Key",
        scopes: [{ resource: "data", actions: ["read"] }],
        rateLimit: { maxRequests: 5, windowMs: 60_000 },
      },
    });
  });

  // Verify once so the stored document carries rateLimitState (a decrement).
  await t.run(async (ctx) => {
    await auth.key.verify(ctx, { secret });
  });

  const got = await t.run(async (ctx) => auth.key.get(ctx, { id: keyId }));
  expect(got).not.toBeNull();
  expect("hashedKey" in (got as object)).toBe(false);
  expect("rateLimitState" in (got as object)).toBe(false);
  // Safe fields survive redaction.
  expect(got!.rateLimit).toEqual({ maxRequests: 5, windowMs: 60_000 });
  expect(got!.prefix).toMatch(/^sk_/);

  // The raw component document still stores the redacted fields — proving the
  // facade is what strips them, not the storage layer.
  const rawDoc = await t.run(async (ctx) =>
    ctx.runQuery(components.auth.user.key.get, { id: keyId as never }),
  );
  expect((rawDoc as { hashedKey?: string }).hashedKey).toBeTruthy();
  expect((rawDoc as { rateLimitState?: unknown }).rateLimitState).toBeTruthy();

  const list = await t.run(async (ctx) =>
    auth.key.list(ctx, {
      where: { userId },
      paginationOpts: { numItems: 10, cursor: null },
    }),
  );
  for (const row of list.page) {
    expect("hashedKey" in (row as object)).toBe(false);
    expect("rateLimitState" in (row as object)).toBe(false);
  }
});
