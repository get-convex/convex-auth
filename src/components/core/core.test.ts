import { convexTest } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";
import {
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";
import { api } from "./_generated/api.js";
import schema from "./schema.js";
import {
  getCreateOrUpdateUserCalls,
  resetCreateOrUpdateUserCalls,
} from "./testApp.js";
import type { AuthClaims, TokenBundle } from "../../lib/types.js";

const modules = import.meta.glob("./**/*.ts");

// The core reads its signing material from `AUTH_PRIVATE_KEY` / `AUTH_JWKS`
// (env vars in production). We mint a real RS256 key pair once and set those
// vars so the suite exercises genuine JWT signing/verification.
const ISSUER = "https://example.convex.site";
const AUDIENCE = "convex";
const CREATE_OR_UPDATE_USER_HANDLE = "testApp:createOrUpdateUser";
let publicJwk: JWK;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const pkcs8 = await exportPKCS8(privateKey);
  publicJwk = await exportJWK(publicKey);
  const kid = "test-key";
  process.env.AUTH_PRIVATE_KEY = btoa(pkcs8);
  process.env.AUTH_JWKS = JSON.stringify({
    keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }],
  });
});

function claims(overrides: Partial<AuthClaims> = {}): AuthClaims {
  return {
    provider: "password",
    providerAccountId: "alice",
    profile: { name: "Alice" },
    ...overrides,
  };
}

function setup() {
  return convexTest(schema, modules);
}

async function signIn(t: ReturnType<typeof setup>, c: AuthClaims) {
  return await t.mutation(api.public.signIn, {
    claims: c,
    createOrUpdateUserHandle: CREATE_OR_UPDATE_USER_HANDLE,
    issuer: ISSUER,
  });
}

/** Assert a refresh succeeded (a session was minted) and narrow away `null`. */
function expectBundle(bundle: TokenBundle | null): TokenBundle {
  expect(bundle).not.toBeNull();
  return bundle as TokenBundle;
}

describe("signIn", () => {
  test("creates an account + session and mints a verifiable JWT", async () => {
    const t = setup();
    const bundle = await signIn(t, claims());

    // The app's createOrUpdateUser echoes the providerAccountId as the user id.
    expect(bundle.userId).toBe("alice");
    expect(bundle.refreshToken).toBeTruthy();
    expect(bundle.accessTokenExpiresAt).toBeGreaterThan(Date.now());
    expect(bundle.refreshTokenExpiresAt).toBeGreaterThan(
      bundle.accessTokenExpiresAt,
    );

    // The access token verifies against the served JWKS with the right claims.
    const key = await importJWK(publicJwk, "RS256");
    const { payload } = await jwtVerify(bundle.accessToken, key, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(payload.sub).toBe("alice");

    // Exactly one account and one session exist.
    const counts = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 1, sessions: 1 });
  });

  test("resolves an existing account instead of creating a duplicate", async () => {
    const t = setup();
    const first = await signIn(t, claims({ profile: { name: "Alice" } }));
    const second = await signIn(t, claims({ profile: { name: "Alice 2.0" } }));

    expect(second.userId).toBe(first.userId);

    const { accounts, sessions } = await t.run(async (ctx) => {
      const accountDocs = await ctx.db.query("accounts").collect();
      const sessionDocs = await ctx.db.query("sessions").collect();
      return {
        accounts: accountDocs.length,
        sessions: sessionDocs.length,
      };
    });
    // One account reused, profile refreshed; a fresh session per sign-in.
    expect(accounts).toBe(1);
    expect(sessions).toBe(2);
  });

  test("invokes the app's user callback on every sign-in", async () => {
    const t = setup();
    resetCreateOrUpdateUserCalls();

    await signIn(t, claims({ profile: { name: "Alice" } }));
    await signIn(t, claims({ profile: { name: "Alice 2.0" } }));

    const calls = getCreateOrUpdateUserCalls();
    // Called both times. First sign-in mints the user (no `userId`); the return
    // carries the known `userId` so the app can update its own user record.
    expect(calls).toHaveLength(2);
    expect(calls[0].userId).toBeNull();
    expect(calls[0].profile).toEqual({ name: "Alice" });
    expect(calls[1].userId).toBe("alice");
    expect(calls[1].profile).toEqual({ name: "Alice 2.0" });
  });
});

describe("refresh", () => {
  test("rotates the refresh token and mints a fresh access token", async () => {
    const t = setup();
    const bundle = await signIn(t, claims());

    const rotated = expectBundle(
      await t.mutation(api.public.refresh, {
        refreshToken: bundle.refreshToken,
        issuer: ISSUER,
      }),
    );
    expect(rotated.refreshToken).not.toBe(bundle.refreshToken);
    expect(rotated.userId).toBe(bundle.userId);

    // The newly minted refresh token works for the next rotation.
    const again = expectBundle(
      await t.mutation(api.public.refresh, {
        refreshToken: rotated.refreshToken,
        issuer: ISSUER,
      }),
    );
    expect(again.refreshToken).not.toBe(rotated.refreshToken);
  });

  test("honors the grace window for a just-rotated token (concurrent refresh)", async () => {
    const t = setup();
    const bundle = await signIn(t, claims());

    await t.mutation(api.public.refresh, {
      refreshToken: bundle.refreshToken,
      issuer: ISSUER,
    });

    // A second refresh presenting the ORIGINAL (now previous) token still
    // resolves via the grace window rather than being rejected.
    const viaGrace = expectBundle(
      await t.mutation(api.public.refresh, {
        refreshToken: bundle.refreshToken,
        issuer: ISSUER,
      }),
    );
    expect(viaGrace.refreshToken).toBeTruthy();
    expect(viaGrace.userId).toBe(bundle.userId);
  });

  test("returns null and clears the session once the refresh token has expired", async () => {
    const t = setup();
    const bundle = await signIn(t, claims());

    // Force the session past its refresh-token expiry.
    await t.run(async (ctx) => {
      const session = await ctx.db.query("sessions").unique();
      await ctx.db.patch(session!._id, {
        refreshTokenExpiresAt: Date.now() - 1000,
      });
    });

    const result = await t.mutation(api.public.refresh, {
      refreshToken: bundle.refreshToken,
      issuer: ISSUER,
    });
    expect(result).toBeNull();

    // The dead session was removed in the same transaction.
    const remaining = await t.run(
      async (ctx) => (await ctx.db.query("sessions").collect()).length,
    );
    expect(remaining).toBe(0);
  });

  test("returns null for an unknown refresh token", async () => {
    const t = setup();
    const result = await t.mutation(api.public.refresh, {
      refreshToken: "not-a-real-token",
      issuer: ISSUER,
    });
    expect(result).toBeNull();
  });
});

describe("signOut", () => {
  test("revokes the session so it can no longer be refreshed", async () => {
    const t = setup();
    const bundle = await signIn(t, claims());

    await t.mutation(api.public.signOut, {
      refreshToken: bundle.refreshToken,
    });
    const remaining = await t.run(
      async (ctx) => (await ctx.db.query("sessions").collect()).length,
    );
    expect(remaining).toBe(0);

    // Refreshing the signed-out session is no longer possible.
    const afterSignOut = await t.mutation(api.public.refresh, {
      refreshToken: bundle.refreshToken,
      issuer: ISSUER,
    });
    expect(afterSignOut).toBeNull();
  });

  test("is idempotent — signing out an already-revoked token does not throw", async () => {
    const t = setup();
    const bundle = await signIn(t, claims());

    await t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken });
    await expect(
      t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken }),
    ).resolves.toBeNull();
  });
});

describe("linkAccount", () => {
  test("links a new identity, is idempotent, and rejects cross-user conflicts", async () => {
    const t = setup();

    // Link a brand-new identity to user "user-1".
    const linked = await t.mutation(api.public.linkAccount, {
      claims: claims({ provider: "google", providerAccountId: "g-123" }),
      userId: "user-1",
    });
    expect(linked).toEqual({ linked: true, userId: "user-1" });

    // Linking the same identity to the same user again is a no-op.
    const again = await t.mutation(api.public.linkAccount, {
      claims: claims({ provider: "google", providerAccountId: "g-123" }),
      userId: "user-1",
    });
    expect(again).toEqual({ linked: false, userId: "user-1" });

    // Linking it to a different user is rejected.
    await expect(
      t.mutation(api.public.linkAccount, {
        claims: claims({ provider: "google", providerAccountId: "g-123" }),
        userId: "user-2",
      }),
    ).rejects.toThrow(/already linked to a different user/i);
  });
});

describe("authenticate", () => {
  test("reports the existing user for a known identity and none otherwise", async () => {
    const t = setup();
    const c = claims({ provider: "google", providerAccountId: "g-known" });

    const unknown = await t.query(api.public.authenticate, { claims: c });
    expect(unknown.existingUserId).toBeUndefined();
    expect(unknown.provider).toBe("google");
    expect(unknown.providerAccountId).toBe("g-known");

    await signIn(t, c);

    const known = await t.query(api.public.authenticate, { claims: c });
    expect(known.existingUserId).toBe("g-known");
  });
});

describe("token lifetime configuration", () => {
  test("honors a custom access-token TTL on sign-in", async () => {
    const t = setup();
    const before = Date.now();
    const bundle = await t.mutation(api.public.signIn, {
      claims: claims(),
      createOrUpdateUserHandle: CREATE_OR_UPDATE_USER_HANDLE,
      issuer: ISSUER,
      accessTokenTtlSeconds: 300, // 5 minutes
    });
    // The JWT `exp` is floored to the second, so allow a small window.
    expect(bundle.accessTokenExpiresAt).toBeGreaterThanOrEqual(
      before + 300_000 - 1000,
    );
    expect(bundle.accessTokenExpiresAt).toBeLessThanOrEqual(
      Date.now() + 300_000,
    );
  });

  test("honors a custom refresh-token TTL on sign-in and on rotation", async () => {
    const t = setup();
    const oneHourSeconds = 60 * 60;
    const oneHourMs = oneHourSeconds * 1000;

    const before = Date.now();
    const bundle = await t.mutation(api.public.signIn, {
      claims: claims(),
      createOrUpdateUserHandle: CREATE_OR_UPDATE_USER_HANDLE,
      issuer: ISSUER,
      refreshTokenTtlSeconds: oneHourSeconds,
    });
    expect(bundle.refreshTokenExpiresAt).toBeGreaterThanOrEqual(
      before + oneHourMs,
    );
    expect(bundle.refreshTokenExpiresAt).toBeLessThanOrEqual(
      Date.now() + oneHourMs,
    );

    // The rotated token gets the configured lifetime too.
    const rotated = expectBundle(
      await t.mutation(api.public.refresh, {
        refreshToken: bundle.refreshToken,
        issuer: ISSUER,
        refreshTokenTtlSeconds: oneHourSeconds,
      }),
    );
    expect(rotated.refreshTokenExpiresAt).toBeLessThanOrEqual(
      Date.now() + oneHourMs,
    );
  });

  test("rejects a configuration where the access TTL is not shorter than the refresh TTL", async () => {
    const t = setup();
    await expect(
      t.mutation(api.public.signIn, {
        claims: claims(),
        createOrUpdateUserHandle: CREATE_OR_UPDATE_USER_HANDLE,
        issuer: ISSUER,
        accessTokenTtlSeconds: 100,
        refreshTokenTtlSeconds: 1, // 1s — shorter than the 100s access token
      }),
    ).rejects.toThrow(/shorter than the refresh-token TTL/i);
  });
});
