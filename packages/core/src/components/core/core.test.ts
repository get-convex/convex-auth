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
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import {
  getCreateUserCalls,
  getOnSignInCalls,
  resetUserCallbackCalls,
} from "./testApp.ts";
import {
  type AuthClaims,
  type TokenBundle,
  USE_USER_ID_AS_ACCOUNT_ID,
} from "../../lib/types.ts";

const modules = import.meta.glob("./**/*.ts");

// The core reads its signing material from `AUTH_PRIVATE_KEY` / `AUTH_JWKS`
// (env vars in production). We mint a real RS256 key pair once and set those
// vars so the suite exercises genuine JWT signing/verification.
const ISSUER = "https://example.convex.site";
const AUDIENCE = "convex";
const CREATE_USER_HANDLE = "testApp:createUser";
const ON_SIGN_IN_HANDLE = "testApp:onSignIn";
const THROWING_ON_SIGN_IN_HANDLE = "testApp:onSignInThatThrows";
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

/** Establish a brand new identity: the account, its app user, and a session. */
async function signUp(t: ReturnType<typeof setup>, c: AuthClaims) {
  return await t.mutation(api.public.signUp, {
    claims: c,
    createUserHandle: CREATE_USER_HANDLE,
    onSignInHandle: ON_SIGN_IN_HANDLE,
    issuer: ISSUER,
  });
}

/** Sign a known identity back in, as an app that attached an `onSignIn` does. */
async function signIn(t: ReturnType<typeof setup>, c: AuthClaims) {
  return await t.mutation(api.public.signIn, {
    claims: c,
    onSignInHandle: ON_SIGN_IN_HANDLE,
    issuer: ISSUER,
  });
}

/** Assert a refresh succeeded (a session was minted) and narrow away `null`. */
function expectBundle(bundle: TokenBundle | null): TokenBundle {
  expect(bundle).not.toBeNull();
  return bundle as TokenBundle;
}

describe("signUp", () => {
  test("creates an account + session and mints a verifiable JWT", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    // The app's createUser echoes the providerAccountId as the user id.
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

  test("invokes the app's createUser with the claims, then onSignIn", async () => {
    const t = setup();
    resetUserCallbackCalls();

    await signUp(t, claims({ profile: { name: "Alice" } }));

    expect(getCreateUserCalls()).toEqual([
      {
        provider: "password",
        providerAccountId: "alice",
        profile: { name: "Alice" },
      },
    ]);
    // A first sign-in is still a sign-in, so onSignIn runs too, with the id
    // createUser just returned. Per-sign-in work has one home.
    expect(getOnSignInCalls()).toEqual([
      {
        provider: "password",
        providerAccountId: "alice",
        profile: { name: "Alice" },
        userId: "alice",
      },
    ]);
  });

  test("creates the user without an onSignIn attached", async () => {
    const t = setup();
    resetUserCallbackCalls();

    const bundle = await t.mutation(api.public.signUp, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
      issuer: ISSUER,
    });

    expect(bundle.userId).toBe("alice");
    expect(getCreateUserCalls()).toHaveLength(1);
    expect(getOnSignInCalls()).toHaveLength(0);
  });

  test("an onSignIn that throws rolls back the user it just created", async () => {
    const t = setup();

    await expect(
      t.mutation(api.public.signUp, {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
        onSignInHandle: THROWING_ON_SIGN_IN_HANDLE,
        issuer: ISSUER,
      }),
    ).rejects.toThrow(/no sign-ins for you/);

    // The account insert is a write of the same mutation, so it rolls back with
    // it, and the app's own users row rolls back the same way. The session was
    // never reached, since onSignIn runs before it is minted.
    const counts = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 0, sessions: 0 });
  });

  test("refuses to sign up an identity that already has an account", async () => {
    const t = setup();
    await signUp(t, claims());

    // Rather than minting a second app user for someone who already has one.
    await expect(signUp(t, claims())).rejects.toThrow(/already\s+exists/i);

    const counts = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 1, sessions: 1 });
  });
});

describe("signIn", () => {
  test("reuses the existing account and mints a fresh session", async () => {
    const t = setup();
    const first = await signUp(t, claims({ profile: { name: "Alice" } }));
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
    // One account reused; a fresh session per sign-in.
    expect(accounts).toBe(1);
    expect(sessions).toBe(2);
  });

  test("invokes the app's onSignIn with the resolved user id and latest claims", async () => {
    const t = setup();
    resetUserCallbackCalls();

    await signUp(t, claims({ profile: { name: "Alice" } }));
    await signIn(t, claims({ profile: { name: "Alice 2.0" } }));

    // The app gets the known id and the fresh profile to sync from. createUser
    // ran once, for the sign-up; onSignIn ran for both.
    expect(getCreateUserCalls()).toHaveLength(1);
    expect(getOnSignInCalls()).toHaveLength(2);
    expect(getOnSignInCalls()[1]).toEqual({
      provider: "password",
      providerAccountId: "alice",
      profile: { name: "Alice 2.0" },
      userId: "alice",
    });
  });

  test("mints the session without notifying an app that attached no onSignIn", async () => {
    const t = setup();
    await signUp(t, claims());
    resetUserCallbackCalls();

    // No `onSignInHandle` is what an app that left `onSignIn` out sends.
    const bundle = await t.mutation(api.public.signIn, {
      claims: claims(),
      issuer: ISSUER,
    });

    expect(bundle.userId).toBe("alice");
    expect(getOnSignInCalls()).toHaveLength(0);
  });

  test("refuses to sign in an identity with no account", async () => {
    const t = setup();

    // A miss means the provider's records and the core's have diverged, and
    // creating a user here would paper over that.
    await expect(signIn(t, claims())).rejects.toThrow(
      /must go through signUp/i,
    );

    const sessions = await t.run(
      async (ctx) => (await ctx.db.query("sessions").collect()).length,
    );
    expect(sessions).toBe(0);
  });
});

describe("signUpWithoutSession", () => {
  test("creates the user and the account, but no session", async () => {
    const t = setup();
    resetUserCallbackCalls();

    const { userId } = await t.mutation(api.public.signUpWithoutSession, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
    });

    // The app's createUser echoes the providerAccountId as the user id.
    expect(userId).toBe("alice");
    expect(getCreateUserCalls()).toHaveLength(1);
    // No sign-in happened, so onSignIn does not run.
    expect(getOnSignInCalls()).toHaveLength(0);

    // The account exists, but no session was minted.
    const counts = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 1, sessions: 0 });
  });

  test("a later signIn resolves the same user and mints a session", async () => {
    const t = setup();
    const { userId } = await t.mutation(api.public.signUpWithoutSession, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
    });

    const bundle = await signIn(t, claims());
    expect(bundle.userId).toBe(userId);

    // The sign-in reused the account that signUpWithoutSession made.
    const counts = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 1, sessions: 1 });
  });

  test("keys the account by the minted user id with USE_USER_ID_AS_ACCOUNT_ID", async () => {
    const t = setup();
    const { userId } = await t.mutation(api.public.signUpWithoutSession, {
      claims: claims({
        providerAccountId: USE_USER_ID_AS_ACCOUNT_ID,
        profile: { email: "alice@example.com" },
      }),
      createUserHandle: CREATE_USER_HANDLE,
    });

    // The account's identifier is the user id the app minted, so a later
    // sign-in that passes the user id resolves the same user.
    const bundle = await signIn(t, claims({ providerAccountId: userId }));
    expect(bundle.userId).toBe(userId);

    const accounts = await t.run(
      async (ctx) => await ctx.db.query("accounts").collect(),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0].providerAccountId).toBe(userId);
  });

  test("refuses an identity that already has an account", async () => {
    const t = setup();
    await signUp(t, claims());

    // Like signUp: a second app user for the same identity is never minted.
    await expect(
      t.mutation(api.public.signUpWithoutSession, {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
      }),
    ).rejects.toThrow(/already\s+exists/i);

    const accounts = await t.run(
      async (ctx) => (await ctx.db.query("accounts").collect()).length,
    );
    expect(accounts).toBe(1);
  });
});

describe("refresh", () => {
  test("rotates the refresh token and mints a fresh access token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

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
    const bundle = await signUp(t, claims());

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
    const bundle = await signUp(t, claims());

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
    const bundle = await signUp(t, claims());

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
    const bundle = await signUp(t, claims());

    await t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken });
    await expect(
      t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken }),
    ).resolves.toBeNull();
  });
});

describe("token lifetime configuration", () => {
  test("honors a custom access-token TTL on sign-up", async () => {
    const t = setup();
    const before = Date.now();
    const bundle = await t.mutation(api.public.signUp, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
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

  test("honors a custom refresh-token TTL on sign-up and on rotation", async () => {
    const t = setup();
    const oneHourSeconds = 60 * 60;
    const oneHourMs = oneHourSeconds * 1000;

    const before = Date.now();
    const bundle = await t.mutation(api.public.signUp, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
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
      t.mutation(api.public.signUp, {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
        issuer: ISSUER,
        accessTokenTtlSeconds: 100,
        refreshTokenTtlSeconds: 1, // 1s — shorter than the 100s access token
      }),
    ).rejects.toThrow(/shorter than the refresh-token TTL/i);
  });
});

describe("getUserIdByAccount", () => {
  test("returns null for an unknown identity", async () => {
    const t = setup();
    const userId = await t.query(api.public.getUserIdByAccount, {
      provider: "password",
      providerAccountId: "alice",
    });
    expect(userId).toBeNull();
  });

  test("returns the user id after the account is created by signUp", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const userId = await t.query(api.public.getUserIdByAccount, {
      provider: "password",
      providerAccountId: "alice",
    });
    expect(userId).toBe(bundle.userId);
  });

  test("does not confuse identities across providers", async () => {
    const t = setup();
    await signUp(
      t,
      claims({ provider: "password", providerAccountId: "alice" }),
    );
    const other = await t.query(api.public.getUserIdByAccount, {
      provider: "google",
      providerAccountId: "alice",
    });
    expect(other).toBeNull();
  });
});
