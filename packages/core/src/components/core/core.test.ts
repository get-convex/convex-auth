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
  getCreateUserCalls,
  getEvaluateSignInCalls,
  getOnSignInCalls,
  resetEvaluateSignInCalls,
  resetUserCallbackCalls,
} from "./testApp.ts";
import {
  type AuthClaims,
  type ProviderSignInOutcome,
  type TokenBundle,
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
    provider: "password",
    providerAccountId: "alice",
    profile: { name: "Alice" },
    ...overrides,
  };
}

function setup() {
  return convexTest(schema, modules);
}

type ConvexTestApi = ReturnType<typeof setup>;

/**
 * Assert a sign-in outcome is `session-created` and unwrap its token bundle. Without
 * an evaluating callback attached (everything in this suite except the
 * incomplete-sign-in tests) that is the only outcome the core produces.
 */
function expectComplete(outcome: ProviderSignInOutcome): TokenBundle {
  expect(outcome.status).toBe("session-created");
  if (outcome.status !== "session-created") throw new Error("unreachable");
  return outcome.tokens;
}

/** Establish a brand new identity: the account, its app user, and a session. */
async function signUp(t: ConvexTestApi, c: AuthClaims) {
  return expectComplete(
    await t.mutation(api.public.signUp, {
      claims: c,
      createUserHandle: CREATE_USER_HANDLE,
      onSignInHandle: ON_SIGN_IN_HANDLE,
      issuer: ISSUER,
    }),
  );
}

/** Sign a known identity back in, as an app that attached an `onSignIn` does. */
async function signIn(t: ConvexTestApi, c: AuthClaims) {
  return expectComplete(
    await t.mutation(api.public.signIn, {
      claims: c,
      onSignInHandle: ON_SIGN_IN_HANDLE,
      issuer: ISSUER,
    }),
  );
}

/** Assert a refresh succeeded (a session was minted) and narrow away `null`. */
function expectBundle(bundle: TokenBundle | null): TokenBundle {
  expect(bundle).not.toBeNull();
  return bundle as TokenBundle;
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
        // Always passed, and empty for a sign-in with no requirements.
        facts: {},
      },
    ]);
  });

  test("creates the user without an onSignIn attached", async () => {
    const t = setup();
    resetUserCallbackCalls();

    const bundle = expectComplete(
      await t.mutation(api.public.signUp, {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
        issuer: ISSUER,
      }),
    );

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
      facts: {},
    });
  });

  test("mints the session without notifying an app that attached no onSignIn", async () => {
    const t = setup();
    await signUp(t, claims());
    resetUserCallbackCalls();

    // No `onSignInHandle` is what an app that left `onSignIn` out sends.
    const bundle = expectComplete(
      await t.mutation(api.public.signIn, {
        claims: claims(),
        issuer: ISSUER,
      }),
    );

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

  test("an unknown token revokes nothing", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    expect(await refresh(t, "not-a-real-token")).toBeNull();

    // Revoking on an unrecognized token would let anyone sign anyone else out
    // by presenting a made-up string. The live session is untouched.
    expect(await sessionCount(t)).toBe(1);
    expect(expectBundle(await refresh(t, bundle.refreshToken))).toBeTruthy();
  });

  test("retires the rotated-away hash and never the current one", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    const first = await currentHash(t);
    const rotated = expectBundle(await refresh(t, bundle.refreshToken));
    const second = await currentHash(t);

    expect(second).not.toBe(first);
    expect(await spentHashes(t)).toEqual([first]);

    expectBundle(await refresh(t, rotated.refreshToken));
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
    const thief = expectBundle(await refresh(t, stolen.refreshToken));
    vi.advanceTimersByTime(REFRESH_GRACE_MS + 1);

    // The victim presents the token they still hold. It was rotated away too
    // long ago to be a concurrent refresh, so the session dies.
    expect(await refresh(t, stolen.refreshToken)).toBeNull();
    expect(await sessionCount(t)).toBe(0);
    expect(await spentHashes(t)).toEqual([]);

    // Revocation is mutual: the thief's token stops working too, which is the
    // whole point — otherwise they keep renewing the session forever.
    expect(await refresh(t, thief.refreshToken)).toBeNull();
  });

  test("detects a replay several rotations back", async () => {
    const t = setup();
    const stolen = await signUp(t, claims());

    // A thief who keeps rotating would evict the victim's hash from any
    // fixed-size history. Retention is by age, so depth doesn't save them.
    let latest = stolen;
    for (let i = 0; i < 5; i++) {
      latest = expectBundle(await refresh(t, latest.refreshToken));
    }
    expect(await spentHashes(t)).toHaveLength(5);
    vi.advanceTimersByTime(REFRESH_GRACE_MS + 1);

    expect(await refresh(t, stolen.refreshToken)).toBeNull();
    expect(await sessionCount(t)).toBe(0);
    expect(await refresh(t, latest.refreshToken)).toBeNull();
  });

  test("a replay inside the grace window is still a concurrent refresh", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    expectBundle(await refresh(t, bundle.refreshToken));
    vi.advanceTimersByTime(REFRESH_GRACE_MS - 1_000);

    // Two tabs sharing a cookie land here routinely; it must not be mistaken
    // for theft.
    expect(expectBundle(await refresh(t, bundle.refreshToken))).toBeTruthy();
    expect(await sessionCount(t)).toBe(1);
  });

  test("a replay after the session is already gone is a no-op", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectBundle(await refresh(t, bundle.refreshToken));
    await t.mutation(api.public.signOut, {
      refreshToken: rotated.refreshToken,
    });
    vi.advanceTimersByTime(REFRESH_GRACE_MS + 1);

    // Two replays racing each other both resolve a session the other deleted.
    await expect(refresh(t, bundle.refreshToken)).resolves.toBeNull();
  });

  test("pruning retires spent hashes, and with them the detection", async () => {
    const t = setup();
    const stolen = await signUp(t, claims());
    const live = expectBundle(await refresh(t, stolen.refreshToken));
    expect(await spentHashes(t)).toHaveLength(1);

    vi.advanceTimersByTime(SPENT_TOKEN_HORIZON_MS + 1);
    // The next rotation pays for the row it adds by erasing the expired one.
    const next = expectBundle(await refresh(t, live.refreshToken));
    expect(await spentHashes(t)).toEqual([await sha256Hex(live.refreshToken)]);

    // Past the horizon the stolen token is merely unknown, so it revokes
    // nothing. Detection is best-effort by construction.
    expect(await refresh(t, stolen.refreshToken)).toBeNull();
    expect(await sessionCount(t)).toBe(1);
    expectBundle(await refresh(t, next.refreshToken));
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
    const afterSignOut = await t.mutation(api.public.refresh, {
      refreshToken: bundle.refreshToken,
      issuer: ISSUER,
    });
    expect(afterSignOut).toBeNull();
  });

  test("revokes when given a token a refresh just rotated away", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectBundle(await refresh(t, bundle.refreshToken));

    // A tab that signs out just after a sibling refreshed presents the token
    // it still holds. Matching only the current hash would no-op here and
    // leave the session alive after an explicit sign-out.
    await t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken });

    expect(await sessionCount(t)).toBe(0);
    expect(await spentHashes(t)).toEqual([]);
    expect(await refresh(t, rotated.refreshToken)).toBeNull();
  });

  test("erases the session's spent hashes along with it", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectBundle(await refresh(t, bundle.refreshToken));
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
    const bundle = expectComplete(
      await t.mutation(api.public.signUp, {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
        issuer: ISSUER,
        accessTokenTtlSeconds: 300, // 5 minutes
      }),
    );
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
    const bundle = expectComplete(
      await t.mutation(api.public.signUp, {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
        issuer: ISSUER,
        refreshTokenTtlSeconds: oneHourSeconds,
      }),
    );
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

// --- Incomplete sign-ins (requirements) --------------------------------------

const EVALUATE_HANDLE = "testApp:evaluateSignIn";
const COMPLETING_EVALUATE_HANDLE = "testApp:evaluateSignInAlwaysComplete";
const THROWING_EVALUATE_HANDLE = "testApp:evaluateSignInThatThrows";

/** Sign up with the evaluating callback attached (requirements mode). */
async function signUpEvaluated(
  t: ReturnType<typeof setup>,
  c: AuthClaims,
  handle: string = EVALUATE_HANDLE,
) {
  return await t.mutation(api.public.signUp, {
    claims: c,
    createUserHandle: CREATE_USER_HANDLE,
    onSignInHandle: handle,
    issuer: ISSUER,
  });
}

/** Sign a known identity back in with the evaluating callback attached. */
async function signInEvaluated(
  t: ReturnType<typeof setup>,
  c: AuthClaims,
  handle: string = EVALUATE_HANDLE,
) {
  return await t.mutation(api.public.signIn, {
    claims: c,
    onSignInHandle: handle,
    issuer: ISSUER,
  });
}

/** Narrow an outcome to its incomplete arm. */
function expectIncomplete(outcome: ProviderSignInOutcome) {
  expect(outcome.status).toBe("pending-requirements");
  if (outcome.status !== "pending-requirements") throw new Error("unreachable");
  return outcome;
}

async function attemptRows(t: ReturnType<typeof setup>) {
  return await t.run(
    async (ctx) => await ctx.db.query("pendingSignInAttempts").collect(),
  );
}

describe("incomplete sign-ins", () => {
  test("an accepting evaluator completes the sign-up and sees empty facts", async () => {
    const t = setup();
    resetEvaluateSignInCalls();

    const outcome = await signUpEvaluated(
      t,
      claims(),
      COMPLETING_EVALUATE_HANDLE,
    );

    const bundle = expectComplete(outcome);
    expect(bundle.userId).toBe("alice");
    expect(getEvaluateSignInCalls()).toEqual([
      {
        provider: "password",
        providerAccountId: "alice",
        profile: { name: "Alice" },
        userId: "alice",
        facts: {},
      },
    ]);
    expect(await attemptRows(t)).toHaveLength(0);
  });

  test("a demanding evaluator parks the sign-up: user + account exist, session withheld", async () => {
    const t = setup();

    const outcome = expectIncomplete(await signUpEvaluated(t, claims()));

    expect(outcome.requirements).toEqual([
      { kind: "test:verify", data: { hint: "prove it" } },
    ]);
    expect(outcome.attemptToken).toBeTruthy();
    expect(outcome.expiresAt).toBeGreaterThan(Date.now());
    expect(outcome.userId).toBe("alice");

    const counts = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
      attempts: (await ctx.db.query("pendingSignInAttempts").collect()).length,
    }));
    // Eager creation: the account exists; only the session is withheld.
    expect(counts).toEqual({ accounts: 1, sessions: 0, attempts: 1 });

    // The raw token is never stored.
    const [attempt] = await attemptRows(t);
    expect(attempt.attemptTokenHash).not.toBe(outcome.attemptToken);
  });

  test("an evaluator that throws on sign-up rolls back the user it just created", async () => {
    const t = setup();

    await expect(
      signUpEvaluated(t, claims(), THROWING_EVALUATE_HANDLE),
    ).rejects.toThrow(/no sign-ins for you/);

    const counts = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
      attempts: (await ctx.db.query("pendingSignInAttempts").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 0, sessions: 0, attempts: 0 });
  });

  test("continueSignIn stays incomplete until the fact is recorded, then completes", async () => {
    const t = setup();
    const parked = expectIncomplete(await signUpEvaluated(t, claims()));

    // Nothing verified yet: still incomplete, budget burned.
    const stillIncomplete = await t.mutation(api.public.continueSignIn, {
      attemptToken: parked.attemptToken,
      onSignInHandle: EVALUATE_HANDLE,
      issuer: ISSUER,
    });
    expect(stillIncomplete.status).toBe("pending-requirements");
    const [afterFirst] = await attemptRows(t);
    expect(afterFirst.continueCount).toBe(1);
    // Continuing never extends the attempt's lifetime.
    expect(afterFirst.expiresAt).toBe(parked.expiresAt);

    // A verification endpoint records the fact...
    const recorded = await t.mutation(api.public.recordAttemptFacts, {
      attemptToken: parked.attemptToken,
      facts: { verified: true },
    });
    expect(recorded).toBe(true);

    // ...and the next round completes: attempt gone, session minted.
    resetEvaluateSignInCalls();
    const done = await t.mutation(api.public.continueSignIn, {
      attemptToken: parked.attemptToken,
      onSignInHandle: EVALUATE_HANDLE,
      issuer: ISSUER,
    });
    expect(done.status).toBe("session-created");
    if (done.status !== "session-created") throw new Error("unreachable");
    expect(done.tokens.userId).toBe("alice");
    expect(getEvaluateSignInCalls()[0].facts).toEqual({ verified: true });

    const counts = await t.run(async (ctx) => ({
      sessions: (await ctx.db.query("sessions").collect()).length,
      attempts: (await ctx.db.query("pendingSignInAttempts").collect()).length,
    }));
    expect(counts).toEqual({ sessions: 1, attempts: 0 });
  });

  test("an unknown attempt token reports expired", async () => {
    const t = setup();
    const outcome = await t.mutation(api.public.continueSignIn, {
      attemptToken: "no-such-token",
      onSignInHandle: EVALUATE_HANDLE,
      issuer: ISSUER,
    });
    expect(outcome).toEqual({ status: "expired" });
  });

  test("an attempt past its TTL reports expired and is deleted", async () => {
    const t = setup();
    const parked = expectIncomplete(await signUpEvaluated(t, claims()));

    await t.run(async (ctx) => {
      const [attempt] = await ctx.db.query("pendingSignInAttempts").collect();
      await ctx.db.patch("pendingSignInAttempts", attempt._id, {
        expiresAt: Date.now() - 1,
      });
    });

    const outcome = await t.mutation(api.public.continueSignIn, {
      attemptToken: parked.attemptToken,
      onSignInHandle: EVALUATE_HANDLE,
      issuer: ISSUER,
    });
    expect(outcome).toEqual({ status: "expired" });
    expect(await attemptRows(t)).toHaveLength(0);
  });

  test("an attempt over its continuation cap reports expired and is deleted", async () => {
    const t = setup();
    const parked = expectIncomplete(await signUpEvaluated(t, claims()));

    await t.run(async (ctx) => {
      const [attempt] = await ctx.db.query("pendingSignInAttempts").collect();
      await ctx.db.patch("pendingSignInAttempts", attempt._id, {
        continueCount: 10,
      });
    });

    const outcome = await t.mutation(api.public.continueSignIn, {
      attemptToken: parked.attemptToken,
      onSignInHandle: EVALUATE_HANDLE,
      issuer: ISSUER,
    });
    expect(outcome).toEqual({ status: "expired" });
    expect(await attemptRows(t)).toHaveLength(0);
  });

  test("a fresh sign-in supersedes the pending attempt and resets its facts", async () => {
    const t = setup();
    const first = expectIncomplete(await signUpEvaluated(t, claims()));
    await t.mutation(api.public.recordAttemptFacts, {
      attemptToken: first.attemptToken,
      facts: { verified: true },
    });

    // A second device signs in fresh (the account now exists): the pending
    // attempt is replaced wholesale — facts reset, so the factor must be
    // re-proven — and the first device's token dies with it.
    const second = expectIncomplete(
      await signInEvaluated(t, claims({ providerAccountId: "alice" })),
    );
    expect(second.attemptToken).not.toBe(first.attemptToken);

    const rows = await attemptRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].facts).toEqual({});
    expect(rows[0].continueCount).toBe(0);

    const firstContinued = await t.mutation(api.public.continueSignIn, {
      attemptToken: first.attemptToken,
      onSignInHandle: EVALUATE_HANDLE,
      issuer: ISSUER,
    });
    expect(firstContinued).toEqual({ status: "expired" });
  });

  test("a fresh completing sign-in deletes the pending attempt", async () => {
    const t = setup();
    const parked = expectIncomplete(await signUpEvaluated(t, claims()));

    const outcome = await signInEvaluated(
      t,
      claims(),
      COMPLETING_EVALUATE_HANDLE,
    );
    expectComplete(outcome);
    expect(await attemptRows(t)).toHaveLength(0);

    const continued = await t.mutation(api.public.continueSignIn, {
      attemptToken: parked.attemptToken,
      onSignInHandle: EVALUATE_HANDLE,
      issuer: ISSUER,
    });
    expect(continued).toEqual({ status: "expired" });
  });

  test("getAttemptContext resolves the subject of a live attempt only", async () => {
    const t = setup();
    const parked = expectIncomplete(await signUpEvaluated(t, claims()));

    const context = await t.query(api.public.getAttemptContext, {
      attemptToken: parked.attemptToken,
    });
    expect(context).toEqual({
      provider: "password",
      providerAccountId: "alice",
      userId: "alice",
    });

    expect(
      await t.query(api.public.getAttemptContext, {
        attemptToken: "no-such-token",
      }),
    ).toBeNull();
  });

  test("penalizeAttempt burns budget and deletes the attempt at the cap", async () => {
    const t = setup();
    const parked = expectIncomplete(await signUpEvaluated(t, claims()));

    expect(
      await t.mutation(api.public.penalizeAttempt, {
        attemptToken: parked.attemptToken,
      }),
    ).toBe(true);
    const [row] = await attemptRows(t);
    expect(row.continueCount).toBe(1);

    await t.run(async (ctx) => {
      const [attempt] = await ctx.db.query("pendingSignInAttempts").collect();
      await ctx.db.patch("pendingSignInAttempts", attempt._id, {
        continueCount: 9,
      });
    });
    // This failure exhausts the cap: the attempt dies.
    expect(
      await t.mutation(api.public.penalizeAttempt, {
        attemptToken: parked.attemptToken,
      }),
    ).toBe(false);
    expect(await attemptRows(t)).toHaveLength(0);
  });

  test("recordAttemptFacts reports a dead attempt instead of resurrecting it", async () => {
    const t = setup();
    expect(
      await t.mutation(api.public.recordAttemptFacts, {
        attemptToken: "no-such-token",
        facts: { verified: true },
      }),
    ).toBe(false);
  });

  test("provider requirements are checked even with no app onSignIn attached", async () => {
    // Before the callback paths were unified, a provider that registered its
    // own requirement while the app attached no `onSignIn` fell down the
    // notify-only path and had its requirement silently dropped.
    const t = setup();
    const providerRequirements = [
      {
        kind: "emailValidation",
        data: { address: "a…@example.com" },
        factFields: ["emailVerified"],
      },
    ];

    const parked = expectIncomplete(
      await t.mutation(api.public.signUp, {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
        providerRequirements,
        issuer: ISSUER,
      }),
    );
    expect(parked.requirements).toEqual([
      { kind: "emailValidation", data: { address: "a…@example.com" } },
    ]);

    await t.mutation(api.public.recordAttemptFacts, {
      attemptToken: parked.attemptToken,
      facts: { emailVerified: true },
      scope: "provider",
    });
    const done = await t.mutation(api.public.continueSignIn, {
      attemptToken: parked.attemptToken,
      providerRequirements,
      issuer: ISSUER,
    });
    expect(done.status).toBe("session-created");
  });

  test("provider requirements gate completion until their provider facts exist", async () => {
    const t = setup();
    resetEvaluateSignInCalls();
    const providerRequirements = [
      {
        kind: "emailValidation",
        data: { address: "a…@example.com" },
        factFields: ["emailVerified"],
      },
    ];

    // The app's evaluator accepts, but the provider requirement is
    // outstanding, so the sign-up parks.
    const parked = expectIncomplete(
      await t.mutation(api.public.signUp, {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
        onSignInHandle: COMPLETING_EVALUATE_HANDLE,
        providerRequirements,
        issuer: ISSUER,
      }),
    );
    expect(parked.requirements).toEqual([
      { kind: "emailValidation", data: { address: "a…@example.com" } },
    ]);

    // Recording the fact under the *app* scope must not satisfy it...
    await t.mutation(api.public.recordAttemptFacts, {
      attemptToken: parked.attemptToken,
      facts: { emailVerified: true },
      scope: "app",
    });
    const still = await t.mutation(api.public.continueSignIn, {
      attemptToken: parked.attemptToken,
      onSignInHandle: COMPLETING_EVALUATE_HANDLE,
      providerRequirements,
      issuer: ISSUER,
    });
    expect(still.status).toBe("pending-requirements");

    // ...but the provider scope does. The app's evaluator never sees the
    // provider bag (its facts stay what the app scope accumulated).
    await t.mutation(api.public.recordAttemptFacts, {
      attemptToken: parked.attemptToken,
      facts: { emailVerified: true },
      scope: "provider",
    });
    resetEvaluateSignInCalls();
    const done = await t.mutation(api.public.continueSignIn, {
      attemptToken: parked.attemptToken,
      onSignInHandle: COMPLETING_EVALUATE_HANDLE,
      providerRequirements,
      issuer: ISSUER,
    });
    expect(done.status).toBe("session-created");
    expect(getEvaluateSignInCalls()[0].facts).toEqual({ emailVerified: true });
  });

  test("USE_USER_ID_AS_ACCOUNT_ID sign-ups key the attempt by the resolved user id", async () => {
    const t = setup();
    const parked = expectIncomplete(
      await t.mutation(api.public.signUp, {
        claims: claims({ providerAccountId: "" }),
        // Mints the user id from the profile ("Alice"): the empty placeholder
        // account id must never leak into the attempt or the evaluator.
        createUserHandle: "testApp:createUserFromProfileName",
        onSignInHandle: EVALUATE_HANDLE,
        issuer: ISSUER,
      }),
    );
    expect(parked.userId).toBe("Alice");
    const context = await t.query(api.public.getAttemptContext, {
      attemptToken: parked.attemptToken,
    });
    expect(context).toEqual({
      provider: "password",
      providerAccountId: "Alice",
      userId: "Alice",
    });
  });
});
