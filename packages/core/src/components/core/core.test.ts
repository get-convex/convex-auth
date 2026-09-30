import { convexTest } from "convex-test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
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
  getCheckSignInCalls,
  getCreateUserCalls,
  getOnSignInCalls,
  resetSignInChecks,
  resetUserCallbackCalls,
  verifyTotp,
} from "./testApp.ts";
import {
  type AuthClaims,
  type TokenBundle,
  type RefreshResult,
  USE_USER_ID_AS_ACCOUNT_ID,
} from "../../lib/types.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { REFRESH_GRACE_MS, SPENT_TOKEN_HORIZON_MS } from "./public.ts";

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
    providerName: "password",
    providerAccountId: "alice",
    profile: { name: "Alice" },
    ...overrides,
  };
}

function setup() {
  return convexTest(schema, modules);
}

type ConvexTestApi = ReturnType<typeof setup>;

/** Establish a brand new identity: the account, its app user, and a session. */
async function signUp(t: ConvexTestApi, c: AuthClaims) {
  return await t.mutation(api.public.signUp, {
    claims: c,
    createUserHandle: CREATE_USER_HANDLE,
    onSignInHandle: ON_SIGN_IN_HANDLE,
    issuer: ISSUER,
  });
}

/**
 * Establish a brand new identity without a session, as a provider with a
 * requirement before the first sign-in does ahead of parking it.
 */
async function createAccount(t: ConvexTestApi, c: AuthClaims) {
  return await t.mutation(api.public.createAccount, {
    claims: c,
    createUserHandle: CREATE_USER_HANDLE,
  });
}

/** Sign a known identity back in, as an app that attached an `onSignIn` does. */
async function signIn(t: ConvexTestApi, c: AuthClaims) {
  return await t.mutation(api.public.signIn, {
    claims: c,
    onSignInHandle: ON_SIGN_IN_HANDLE,
    issuer: ISSUER,
  });
}

/** Assert a refresh rotated the token, and narrow to the new bundle. */
function expectRotated(result: RefreshResult): TokenBundle {
  expect(result.kind).toBe("rotated");
  return (result as Extract<RefreshResult, { kind: "rotated" }>).tokens;
}

/**
 * Assert a refresh resolved through the grace window without rotating, and
 * narrow to the access-only session.
 */
function expectReused(
  result: RefreshResult,
): Extract<RefreshResult, { kind: "reused" }> {
  expect(result.kind).toBe("reused");
  return result as Extract<RefreshResult, { kind: "reused" }>;
}

/** Exchange a refresh token, as a client rotating its session does. */
async function refresh(t: ConvexTestApi, refreshToken: string) {
  return await t.mutation(api.public.refresh, { refreshToken, issuer: ISSUER });
}

/** How many sessions currently exist. */
async function sessionCount(t: ConvexTestApi) {
  return await t.run(
    async (ctx) => (await ctx.db.query("sessions").collect()).length,
  );
}

/** The hashes rotation has retired, oldest first. */
async function spentHashes(t: ConvexTestApi) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("spentRefreshTokens").collect()).map((r) => r.hash),
  );
}

/** The hash of the token a session currently accepts. */
async function currentHash(t: ConvexTestApi) {
  return await t.run(
    async (ctx) => (await ctx.db.query("sessions").unique())?.refreshTokenHash,
  );
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
        provider: {
          name: "password",
          accountId: "alice",
          profile: { name: "Alice" },
        },
      },
    ]);
    // A first sign-in is still a sign-in, so onSignIn runs too, with the id
    // createUser just returned. Per-sign-in work has one home.
    expect(getOnSignInCalls()).toEqual([
      {
        provider: {
          name: "password",
          accountId: "alice",
          profile: { name: "Alice" },
        },
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
      provider: {
        name: "password",
        accountId: "alice",
        profile: { name: "Alice 2.0" },
      },
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

describe("refresh", () => {
  test("rotates the refresh token and mints a fresh access token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    expect(rotated.refreshToken).not.toBe(bundle.refreshToken);
    expect(rotated.userId).toBe(bundle.userId);

    // The newly minted refresh token works for the next rotation.
    const again = expectRotated(await refresh(t, rotated.refreshToken));
    expect(again.refreshToken).not.toBe(rotated.refreshToken);
  });

  test("a just-rotated token resolves via the grace window without rotating again", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    await refresh(t, bundle.refreshToken);

    // A second refresh presenting the ORIGINAL (now previous) token still
    // resolves via the grace window rather than being rejected — but reports
    // `reused` and mints only an access token.
    const viaGrace = expectReused(await refresh(t, bundle.refreshToken));
    expect(viaGrace.accessToken).toBeTruthy();
    expect(viaGrace.userId).toBe(bundle.userId);
    expect(viaGrace).not.toHaveProperty("refreshToken");
  });

  test("a grace-window refresh leaves the winner's token current", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    // The caller that wins the race rotates and is handed the replacement.
    const winner = expectRotated(await refresh(t, bundle.refreshToken));
    const hashAfterWin = await currentHash(t);
    const spentAfterWin = await spentHashes(t);

    // The straggler presents the token the winner already spent.
    expectReused(await refresh(t, bundle.refreshToken));

    // Rotating here would spend the winner's brand-new token, and the winner
    // would be signed out — as suspected theft — once it left the grace window.
    // So the grace arm must write nothing at all.
    expect(await currentHash(t)).toBe(hashAfterWin);
    expect(await spentHashes(t)).toEqual(spentAfterWin);

    // The winner's token is still the live one.
    expectRotated(await refresh(t, winner.refreshToken));
  });

  test("every racer sharing one token succeeds, and exactly one rotates", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    const kinds: string[] = [];
    for (let i = 0; i < 5; i++) {
      kinds.push((await refresh(t, bundle.refreshToken)).kind);
    }

    // Nobody is signed out, and the chain forks nowhere: one rotation, and one
    // spent hash to show for it.
    expect(kinds).toEqual(["rotated", "reused", "reused", "reused", "reused"]);
    expect(await sessionCount(t)).toBe(1);
    expect(await spentHashes(t)).toHaveLength(1);
  });

  test("reports no session and clears it once the refresh token has expired", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    // Force the session past its refresh-token expiry.
    await t.run(async (ctx) => {
      const session = await ctx.db.query("sessions").unique();
      await ctx.db.patch(session!._id, {
        refreshTokenExpiresAt: Date.now() - 1000,
      });
    });

    const result = await refresh(t, bundle.refreshToken);
    expect(result.kind).toBe("noSession");

    // The dead session was removed in the same transaction.
    expect(await sessionCount(t)).toBe(0);
  });

  test("reports no session for an unknown refresh token", async () => {
    const t = setup();
    const result = await refresh(t, "not-a-real-token");
    expect(result.kind).toBe("noSession");
  });

  test("an unknown token revokes nothing", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    expect((await refresh(t, "not-a-real-token")).kind).toBe("noSession");

    // Revoking on an unrecognized token would let anyone sign anyone else out
    // by presenting a made-up string. The live session is untouched.
    expect(await sessionCount(t)).toBe(1);
    expect(expectRotated(await refresh(t, bundle.refreshToken))).toBeTruthy();
  });

  test("retires the rotated-away hash and never the current one", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    const first = await currentHash(t);
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    const second = await currentHash(t);

    expect(second).not.toBe(first);
    expect(await spentHashes(t)).toEqual([first]);

    expectRotated(await refresh(t, rotated.refreshToken));
    // One spent hash per rotation, and the live token is never among them.
    expect(await spentHashes(t)).toEqual([first, second]);
    expect(await spentHashes(t)).not.toContain(await currentHash(t));
  });
});

describe("refresh-token reuse detection", () => {
  // `_creationTime` is what dates a spent hash, and it can't be patched, so
  // aging one past the grace window means moving the clock.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a token replayed past the grace window revokes the session", async () => {
    const t = setup();
    const stolen = await signUp(t, claims());

    // The thief gets there first, so the session's live token is now theirs.
    const thief = expectRotated(await refresh(t, stolen.refreshToken));
    vi.advanceTimersByTime(REFRESH_GRACE_MS + 1);

    // The victim presents the token they still hold. It was rotated away too
    // long ago to be a concurrent refresh, so the session dies.
    expect((await refresh(t, stolen.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
    expect(await spentHashes(t)).toEqual([]);

    // Revocation is mutual: the thief's token stops working too, which is the
    // whole point — otherwise they keep renewing the session forever.
    expect((await refresh(t, thief.refreshToken)).kind).toBe("noSession");
  });

  test("detects a replay several rotations back", async () => {
    const t = setup();
    const stolen = await signUp(t, claims());

    // A thief who keeps rotating would evict the victim's hash from any
    // fixed-size history. Retention is by age, so depth doesn't save them.
    let latest = stolen;
    for (let i = 0; i < 5; i++) {
      latest = expectRotated(await refresh(t, latest.refreshToken));
    }
    expect(await spentHashes(t)).toHaveLength(5);
    vi.advanceTimersByTime(REFRESH_GRACE_MS + 1);

    expect((await refresh(t, stolen.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
    expect((await refresh(t, latest.refreshToken)).kind).toBe("noSession");
  });

  test("a replay inside the grace window is still a concurrent refresh", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    expectRotated(await refresh(t, bundle.refreshToken));
    vi.advanceTimersByTime(REFRESH_GRACE_MS - 1_000);

    // Two tabs sharing a cookie land here routinely; it must not be mistaken
    // for theft.
    expectReused(await refresh(t, bundle.refreshToken));
    expect(await sessionCount(t)).toBe(1);
  });

  test("a replay after the session is already gone is a no-op", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    await t.mutation(api.public.signOut, {
      refreshToken: rotated.refreshToken,
    });
    vi.advanceTimersByTime(REFRESH_GRACE_MS + 1);

    // Two replays racing each other both resolve a session the other deleted.
    expect((await refresh(t, bundle.refreshToken)).kind).toBe("noSession");
  });

  test("pruning retires spent hashes, and with them the detection", async () => {
    const t = setup();
    const stolen = await signUp(t, claims());
    const live = expectRotated(await refresh(t, stolen.refreshToken));
    expect(await spentHashes(t)).toHaveLength(1);

    vi.advanceTimersByTime(SPENT_TOKEN_HORIZON_MS + 1);
    // The next rotation pays for the row it adds by erasing the expired one.
    const next = expectRotated(await refresh(t, live.refreshToken));
    expect(await spentHashes(t)).toEqual([await sha256Hex(live.refreshToken)]);

    // Past the horizon the stolen token is merely unknown, so it revokes
    // nothing. Detection is best-effort by construction.
    expect((await refresh(t, stolen.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(1);
    expectRotated(await refresh(t, next.refreshToken));
  });

  test("the detection horizon outlives the grace window", () => {
    // A spent hash erased while still inside its grace window would turn a
    // routine concurrent refresh into a forced sign-out.
    expect(SPENT_TOKEN_HORIZON_MS).toBeGreaterThan(REFRESH_GRACE_MS);
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
    expect((await refresh(t, bundle.refreshToken)).kind).toBe("noSession");
  });

  test("revokes when given a token a refresh just rotated away", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));

    // A tab that signs out just after a sibling refreshed presents the token
    // it still holds. Matching only the current hash would no-op here and
    // leave the session alive after an explicit sign-out.
    await t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken });

    expect(await sessionCount(t)).toBe(0);
    expect(await spentHashes(t)).toEqual([]);
    expect((await refresh(t, rotated.refreshToken)).kind).toBe("noSession");
  });

  test("erases the session's spent hashes along with it", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    expect(await spentHashes(t)).toHaveLength(1);

    await t.mutation(api.public.signOut, {
      refreshToken: rotated.refreshToken,
    });

    // A spent hash must never outlive the session it names.
    expect(await spentHashes(t)).toEqual([]);
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
    const rotated = expectRotated(
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
      claims({ providerName: "password", providerAccountId: "alice" }),
    );
    const other = await t.query(api.public.getUserIdByAccount, {
      provider: "google",
      providerAccountId: "alice",
    });
    expect(other).toBeNull();
  });
});

describe("createAccount", () => {
  test("creates the user and the account, but no session and no sign-in", async () => {
    const t = setup();
    resetUserCallbackCalls();

    const { userId } = await createAccount(t, claims());
    // The app's createUser echoes the providerAccountId as the user id.
    expect(userId).toBe("alice");
    expect(getCreateUserCalls()).toHaveLength(1);
    // Nothing was signed in, so the app was not told about a sign-in.
    expect(getOnSignInCalls()).toHaveLength(0);

    const counts = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 1, sessions: 0 });
    const resolved = await t.query(api.public.getUserIdByAccount, {
      provider: "password",
      providerAccountId: "alice",
    });
    expect(resolved).toBe(userId);
  });

  test("a later signIn resolves the account", async () => {
    const t = setup();
    const { userId } = await createAccount(t, claims());
    resetUserCallbackCalls();

    // The requirement was never met, or was met another day. Signing in finds
    // the same user rather than failing or minting a duplicate, and that is
    // the identity's first sign-in as far as the app can tell.
    const bundle = await signIn(t, claims());
    expect(bundle.userId).toBe(userId);
    expect(getCreateUserCalls()).toHaveLength(0);
    expect(getOnSignInCalls()).toHaveLength(1);
    const accounts = await t.run(
      async (ctx) => (await ctx.db.query("accounts").collect()).length,
    );
    expect(accounts).toBe(1);
  });

  test("keys the account by the minted user id with USE_USER_ID_AS_ACCOUNT_ID", async () => {
    const t = setup();
    const { userId } = await createAccount(
      t,
      claims({
        providerAccountId: USE_USER_ID_AS_ACCOUNT_ID,
        profile: { email: "alice@example.com" },
      }),
    );

    const accounts = await t.run(
      async (ctx) => await ctx.db.query("accounts").collect(),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ providerAccountId: userId, userId });
  });

  test("refuses an identity that already has an account", async () => {
    const t = setup();
    await signUp(t, claims());
    resetUserCallbackCalls();

    // Like signUp: a second app user for the same identity is never minted.
    await expect(createAccount(t, claims())).rejects.toThrow(
      /already\s+exists/i,
    );
    expect(getCreateUserCalls()).toHaveLength(0);
    const accounts = await t.run(
      async (ctx) => (await ctx.db.query("accounts").collect()).length,
    );
    expect(accounts).toBe(1);
  });
});

describe("pending sign-ins", () => {
  // The sign-in checks of the test app, as a provider's helper would have
  // stored them: the requirement's name, next to the handle of its check.
  // `checkTotp` does not pass until `verifyTotp`.
  const TOTP_CHECK = { requirement: "totp", handle: "testApp:checkTotp" };
  const EMAIL_CHECK = { requirement: "email", handle: "testApp:checkEmail" };
  const SATISFIED_CHECK = {
    requirement: "satisfied",
    handle: "testApp:checkSatisfied",
  };
  type StoredCheck = typeof TOTP_CHECK;

  beforeEach(() => {
    resetSignInChecks();
  });

  /**
   * Park a known identity's sign-in, as a provider with an unmet requirement
   * does. Parked on the TOTP check alone unless told otherwise.
   */
  async function defer(
    t: ConvexTestApi,
    c: AuthClaims,
    options: { checks?: StoredCheck[]; attemptTtlSeconds?: number } = {},
  ) {
    return await t.mutation(api.public.deferSignIn, {
      claims: c,
      checks: options.checks ?? [TOTP_CHECK],
      onSignInHandle: ON_SIGN_IN_HANDLE,
      attemptTtlSeconds: options.attemptTtlSeconds,
    });
  }

  /** Resolve an attempt token the way a requirement-satisfying function does. */
  async function getPending(t: ConvexTestApi, attemptToken: string) {
    return await t.query(api.public.getPendingSignIn, { attemptToken });
  }

  /** Continue a parked sign-in, as the app's `continueSignIn` does. */
  async function complete(t: ConvexTestApi, attemptToken: string) {
    return await t.mutation(api.public.completePendingSignIn, {
      attemptToken,
      issuer: ISSUER,
    });
  }

  type CompleteResult = Awaited<ReturnType<typeof complete>>;

  /** Assert a continuation minted, and narrow to the bundle. */
  function expectComplete(result: CompleteResult): TokenBundle {
    expect(result?.status).toBe("complete");
    return (result as Extract<CompleteResult, { status: "complete" }>).tokens;
  }

  /** How many pending sign-ins currently exist. */
  async function pendingCount(t: ConvexTestApi) {
    return await t.run(
      async (ctx) => (await ctx.db.query("pendingSignIns").collect()).length,
    );
  }

  /** The one pending sign-in row. */
  async function storedPending(t: ConvexTestApi) {
    return await t.run(
      async (ctx) => (await ctx.db.query("pendingSignIns").unique())!,
    );
  }

  test("parks the sign-in: no session, no onSignIn, and a resolvable token", async () => {
    const t = setup();
    const { userId } = await signUp(t, claims());
    resetUserCallbackCalls();

    const deferred = await defer(t, claims());
    expect(deferred.userId).toBe(userId);
    expect(deferred.expiresAt).toBeGreaterThan(Date.now());
    // Only the sign-up's session exists: deferring minted nothing.
    expect(await sessionCount(t)).toBe(1);
    // Nothing was signed in yet, so the app was not told about a sign-in,
    // and nothing was continued, so no check ran.
    expect(getOnSignInCalls()).toHaveLength(0);
    expect(getCheckSignInCalls()).toHaveLength(0);

    // The token is stored only as a hash. The row keeps the identity for
    // minting later, and pins the checks and the onSignIn to run then.
    const stored = await storedPending(t);
    expect(stored.attemptTokenHash).toBe(
      await sha256Hex(deferred.attemptToken),
    );
    expect(stored._id).toBe(deferred.attemptId);
    expect(stored).toMatchObject({
      provider: "password",
      providerAccountId: "alice",
      profile: { name: "Alice" },
      checks: [TOTP_CHECK],
      onSignInHandle: ON_SIGN_IN_HANDLE,
    });
    // The token resolves to the subject and the attempt, and to nothing else:
    // a requirement verifies a factor for a user, not for a profile.
    expect(await getPending(t, deferred.attemptToken)).toEqual({
      attemptId: deferred.attemptId,
      userId,
      expiresAt: deferred.expiresAt,
    });
  });

  test("refuses to defer an identity with no account", async () => {
    const t = setup();
    await expect(defer(t, claims())).rejects.toThrow(/no account/);
    expect(await pendingCount(t)).toBe(0);
  });

  test("parks the first sign-in of an account created without a session", async () => {
    const t = setup();
    resetUserCallbackCalls();
    // A provider with a requirement before the first sign-in establishes the
    // account without a session, then parks the sign-in like any other.
    const { userId } = await createAccount(t, claims());
    const deferred = await defer(t, claims());
    expect(deferred.userId).toBe(userId);
    expect(await sessionCount(t)).toBe(0);
    expect(getOnSignInCalls()).toHaveLength(0);
    expect(await getPending(t, deferred.attemptToken)).toMatchObject({
      attemptId: deferred.attemptId,
      userId,
    });
  });

  test("a parked first sign-in mints the first session and runs onSignIn then", async () => {
    const t = setup();
    resetUserCallbackCalls();
    const { userId } = await createAccount(t, claims());
    const deferred = await defer(t, claims());

    verifyTotp();
    const bundle = expectComplete(await complete(t, deferred.attemptToken));
    expect(bundle.userId).toBe(userId);
    expect(getOnSignInCalls()).toEqual([
      {
        provider: {
          name: "password",
          accountId: "alice",
          profile: { name: "Alice" },
        },
        userId,
      },
    ]);
    expect(await sessionCount(t)).toBe(1);
  });

  test("continuing runs the checks with the attempt's subject and withholds the session while one is outstanding", async () => {
    const t = setup();
    const { userId } = await signUp(t, claims());
    resetUserCallbackCalls();
    const deferred = await defer(t, claims(), {
      checks: [TOTP_CHECK, SATISFIED_CHECK],
    });

    // The client came back before verifying anything.
    const result = await complete(t, deferred.attemptToken);
    expect(result).toEqual({
      status: "incomplete",
      attemptToken: deferred.attemptToken,
      expiresAt: deferred.expiresAt,
      requirements: ["totp"],
    });
    // Every check ran, and was asked about this subject and this attempt,
    // never about anything the caller supplied. Only the failing check's
    // requirement is reported, under the name it was parked with.
    expect(getCheckSignInCalls()).toEqual([
      { userId, attemptId: deferred.attemptId },
      { userId, attemptId: deferred.attemptId },
    ]);
    // Nothing happened: no session, no onSignIn, and the attempt stays live
    // for the client to continue again.
    expect(await sessionCount(t)).toBe(1);
    expect(getOnSignInCalls()).toHaveLength(0);
    expect(await pendingCount(t)).toBe(1);
    expect(await getPending(t, deferred.attemptToken)).not.toBeNull();

    // Once the requirement is met, the same token finishes the sign-in.
    verifyTotp();
    expectComplete(await complete(t, deferred.attemptToken));
    expect(await sessionCount(t)).toBe(2);
  });

  test("reports the requirements of every failing check together, once each", async () => {
    const t = setup();
    await signUp(t, claims());
    // The same check parked twice under one name is reported once: the name
    // is what gets deduplicated.
    const { attemptToken } = await defer(t, claims(), {
      checks: [TOTP_CHECK, EMAIL_CHECK, TOTP_CHECK],
    });

    const result = await complete(t, attemptToken);
    expect(result).toMatchObject({
      status: "incomplete",
      requirements: ["totp", "email"],
    });

    // Satisfying one check is not satisfying them all.
    verifyTotp();
    expect(await complete(t, attemptToken)).toMatchObject({
      status: "incomplete",
      requirements: ["email"],
    });
  });

  test("an attempt parked with no checks completes at once", async () => {
    const t = setup();
    await signUp(t, claims());
    const { attemptToken } = await defer(t, claims(), { checks: [] });

    expectComplete(await complete(t, attemptToken));
    expect(getCheckSignInCalls()).toHaveLength(0);
  });

  test("completing mints a session, runs the onSignIn pinned at deferral once, and spends the token", async () => {
    const t = setup();
    const { userId } = await signUp(t, claims());
    resetUserCallbackCalls();
    const { attemptToken } = await defer(t, claims());
    verifyTotp();

    const bundle = expectComplete(await complete(t, attemptToken));
    expect(bundle.userId).toBe(userId);
    // The session is a real one: the refresh token rotates like any other.
    expectRotated(await refresh(t, bundle.refreshToken));
    // The sign-in happened now, so the app heard about it exactly once, with
    // the claims the deferred sign-in carried.
    expect(getOnSignInCalls()).toEqual([
      {
        provider: {
          name: "password",
          accountId: "alice",
          profile: { name: "Alice" },
        },
        userId,
      },
    ]);

    // Single use: the row is gone, and a replay mints nothing.
    expect(await pendingCount(t)).toBe(0);
    expect(await getPending(t, attemptToken)).toBeNull();
    expect(await complete(t, attemptToken)).toBeNull();
    expect(await sessionCount(t)).toBe(2);
  });

  test("completing an attempt parked without an onSignIn notifies nothing", async () => {
    const t = setup();
    await signUp(t, claims());
    resetUserCallbackCalls();
    const { attemptToken } = await t.mutation(api.public.deferSignIn, {
      claims: claims(),
      checks: [],
    });

    expectComplete(await complete(t, attemptToken));
    expect(getOnSignInCalls()).toHaveLength(0);
    expect(await sessionCount(t)).toBe(2);
  });

  test("an unknown token resolves to nothing and completes nothing", async () => {
    const t = setup();
    await signUp(t, claims());
    await defer(t, claims());

    expect(await getPending(t, "not-a-real-token")).toBeNull();
    expect(await complete(t, "not-a-real-token")).toBeNull();
    // The real attempt is untouched, and no check ran for a token that names
    // nothing.
    expect(await pendingCount(t)).toBe(1);
    expect(getCheckSignInCalls()).toHaveLength(0);
  });

  test("an expired attempt resolves to nothing and completes nothing", async () => {
    const t = setup();
    await signUp(t, claims());
    const { attemptToken } = await defer(t, claims());
    await t.run(async (ctx) => {
      const pending = (await ctx.db.query("pendingSignIns").unique())!;
      await ctx.db.patch("pendingSignIns", pending._id, {
        expiresAt: Date.now() - 1000,
      });
    });

    verifyTotp();
    expect(await getPending(t, attemptToken)).toBeNull();
    expect(await complete(t, attemptToken)).toBeNull();
    expect(await sessionCount(t)).toBe(1);
  });

  test("a fresh deferral supersedes the identity's earlier attempt", async () => {
    const t = setup();
    await signUp(t, claims());
    const first = await defer(t, claims());
    const second = await defer(t, claims());
    verifyTotp();

    // One live attempt per identity, and the new one has a new id: proof a
    // requirement component recorded against the first id keys nothing now.
    expect(await pendingCount(t)).toBe(1);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(await getPending(t, first.attemptToken)).toBeNull();
    expect(await complete(t, first.attemptToken)).toBeNull();
    expectComplete(await complete(t, second.attemptToken));
  });

  test("completing re-resolves the account and mints nothing for one that is gone", async () => {
    const t = setup();
    await signUp(t, claims());
    const { attemptToken } = await defer(t, claims());
    verifyTotp();
    await t.run(async (ctx) => {
      const account = (await ctx.db.query("accounts").unique())!;
      await ctx.db.delete("accounts", account._id);
    });

    expect(await complete(t, attemptToken)).toBeNull();
    expect(await pendingCount(t)).toBe(0);
    expect(await sessionCount(t)).toBe(1);
  });

  test("deferring sweeps expired attempts, and only those", async () => {
    const t = setup();
    await signUp(t, claims());
    await signUp(t, claims({ providerAccountId: "bob" }));
    await signUp(t, claims({ providerAccountId: "carol" }));
    await defer(t, claims());
    await defer(t, claims({ providerAccountId: "bob" }));
    // Alice's attempt lapses; Bob's is still live.
    await t.run(async (ctx) => {
      const alice = (await ctx.db
        .query("pendingSignIns")
        .withIndex("by_provider_account", (q) =>
          q.eq("provider", "password").eq("providerAccountId", "alice"),
        )
        .unique())!;
      await ctx.db.patch("pendingSignIns", alice._id, {
        expiresAt: Date.now() - 1000,
      });
    });

    await defer(t, claims({ providerAccountId: "carol" }));
    const remaining = await t.run(async (ctx) =>
      (await ctx.db.query("pendingSignIns").collect()).map(
        (r) => r.providerAccountId,
      ),
    );
    expect(remaining.sort()).toEqual(["bob", "carol"]);
  });

  test("honors a custom attempt TTL and rejects a nonsensical one", async () => {
    const t = setup();
    await signUp(t, claims());
    const before = Date.now();
    const deferred = await defer(t, claims(), { attemptTtlSeconds: 60 });
    expect(deferred.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(deferred.expiresAt).toBeLessThan(before + 60_000 + 5_000);

    await expect(defer(t, claims(), { attemptTtlSeconds: 0 })).rejects.toThrow(
      /positive/,
    );
  });
});
