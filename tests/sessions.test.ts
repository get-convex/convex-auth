import { api, components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { decodeJwt } from "jose";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { convexTest, TestConvex } from "./convex/setup";
import { expectSignInSession, TEST_EMAIL, TEST_PASSWORD } from "./helpers";

const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string) {
  if (!(name in savedEnv)) {
    savedEnv[name] = process.env[name];
  }
  process.env[name] = value;
}

afterEach(() => {
  vi.useRealTimers();
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
    delete savedEnv[key];
  }
});

test("session refresh", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema);
  const initialTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        flow: "signUp",
      },
    }),
  );
  const { refreshToken } = initialTokens!;

  const TWO_HOURS_MS = 1000 * 60 * 60 * 2;
  vi.advanceTimersByTime(TWO_HOURS_MS);

  const tokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      refreshToken,
      params: {},
    }),
  );

  expect(tokens).not.toBeNull();
});

test("refreshed access token gets a unique jti", async () => {
  const t = convexTest(schema);

  const initialTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        flow: "signUp",
      },
    }),
  );
  const { refreshToken } = initialTokens!;

  const refreshedTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      refreshToken,
      params: {},
    }),
  );

  const firstJti = decodeJwt(initialTokens!.token).jti;
  const firstClaims = decodeJwt(initialTokens!.token);
  const refreshedClaims = decodeJwt(refreshedTokens!.token);
  const refreshedJti = refreshedClaims.jti;

  expect(typeof firstJti).toBe("string");
  expect(typeof refreshedJti).toBe("string");
  expect(refreshedJti).not.toEqual(firstJti);
  expect(refreshedClaims.sub).toEqual(firstClaims.sub);
  expect(refreshedClaims.sid).toEqual(firstClaims.sid);
});

test("refresh token expiration", async () => {
  vi.useFakeTimers();
  const ONE_DAY_MS = 1000 * 60 * 60 * 24;
  setEnv("AUTH_SESSION_INACTIVE_DURATION_MS", `${ONE_DAY_MS}`);
  const t = convexTest(schema);
  const initialTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        flow: "signUp",
      },
    }),
  );
  const { refreshToken } = initialTokens!;

  vi.advanceTimersByTime(2 * ONE_DAY_MS);

  const tokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      refreshToken,
      params: {},
    }),
  );

  expect(tokens).toBeNull();
});

async function exchangeToken(t: TestConvex<typeof schema>, refreshToken: string) {
  const newTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      refreshToken,
      params: {},
    }),
  );
  return newTokens?.refreshToken ?? null;
}

test("refresh token reuse detection", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema);
  const initialTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        flow: "signUp",
      },
    }),
  );
  const { refreshToken: refreshTokenA } = initialTokens!;

  const refreshTokenB = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB).not.toBeNull();

  vi.advanceTimersByTime(5000);

  const refreshTokenB1 = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB1).not.toBeNull();
  expect(refreshTokenB1).toEqual(refreshTokenB);

  vi.advanceTimersByTime(5001);

  const refreshTokenB2 = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB2).not.toBeNull();
  expect(refreshTokenB2).toEqual(refreshTokenB1);

  const refreshTokenC = await exchangeToken(t, refreshTokenB!);
  expect(refreshTokenC).not.toBeNull();

  const refreshTokenB3 = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB3).toBeNull();

  const refreshTokenD = await exchangeToken(t, refreshTokenC!);
  expect(refreshTokenD).toBeNull();
});

test("refresh token reuse with racing requests", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema);
  const initialTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        flow: "signUp",
      },
    }),
  );
  const { refreshToken: refreshTokenA } = initialTokens!;

  const refreshTokenB = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB).not.toBeNull();

  vi.advanceTimersByTime(5000);

  const refreshTokenB1 = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB1).not.toBeNull();
  expect(refreshTokenB1).toEqual(refreshTokenB);

  const refreshTokenC = await exchangeToken(t, refreshTokenB!);
  expect(refreshTokenC).not.toBeNull();

  const refreshTokenC1 = await exchangeToken(t, refreshTokenB1!);
  expect(refreshTokenC1).not.toBeNull();
});

test("refresh token theft revokes the entire session", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema);
  const initialTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        flow: "signUp",
      },
    }),
  );
  const { refreshToken: refreshTokenA } = initialTokens!;

  const refreshTokenB = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB).not.toBeNull();

  const refreshTokenC = await exchangeToken(t, refreshTokenB!);
  expect(refreshTokenC).not.toBeNull();

  vi.advanceTimersByTime(5000);

  const refreshTokenB1 = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB1).not.toBeNull();
  expect(refreshTokenB1).not.toEqual(refreshTokenB);

  const refreshTokenC1 = await exchangeToken(t, refreshTokenB1!);
  expect(refreshTokenC1).not.toBeNull();

  vi.advanceTimersByTime(5001);

  const refreshResultB = await exchangeToken(t, refreshTokenB!);
  expect(refreshResultB).toBeNull();

  expect(await exchangeToken(t, refreshTokenC!)).toBeNull();
  expect(await exchangeToken(t, refreshTokenC1!)).toBeNull();
  expect(await exchangeToken(t, refreshTokenB1!)).toBeNull();

  const reuseEvents = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.event.list, {
      where: { kind: "session.refresh_reuse_detected" },
      paginationOpts: { numItems: 10, cursor: null },
    });
  });
  expect(reuseEvents.page.length).toBeGreaterThan(0);
  expect(reuseEvents.page.every((p: any) => p.kind === "session.refresh_reuse_detected")).toBe(
    true,
  );
  expect(reuseEvents.page.every((p: any) => p.outcome === "failure")).toBe(true);
  expect(reuseEvents.page.some((p: any) => p.subjectType === "session")).toBe(true);
});

test("session expiration", async () => {
  vi.useFakeTimers();
  const ONE_DAY_MS = 1000 * 60 * 60 * 24;
  setEnv("AUTH_SESSION_TOTAL_DURATION_MS", `${ONE_DAY_MS}`);
  const t = convexTest(schema);
  const initialTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        flow: "signUp",
      },
    }),
  );
  const { refreshToken } = initialTokens!;

  vi.advanceTimersByTime(2 * ONE_DAY_MS);

  const refreshedTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      refreshToken,
      params: {},
    }),
  );

  expect(refreshedTokens).toBeNull();
});

test("password sign-in on an authenticated context replaces the old session", async () => {
  const t = convexTest(schema);

  const firstTokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      provider: "password",
      params: { email: TEST_EMAIL, password: TEST_PASSWORD, flow: "signUp" },
    }),
  );
  const claims = decodeJwt(firstTokens!.token);
  const asUser = t.withIdentity({ subject: claims.sub, sid: claims.sid as never });

  // Signing in again while already authenticated should REPLACE, not stack:
  // the previous session's refresh token must stop working.
  const secondTokens = expectSignInSession(
    await asUser.action(api.auth.signIn, {
      provider: "password",
      params: { email: TEST_EMAIL, password: TEST_PASSWORD, flow: "signIn" },
    }),
  );
  expect(secondTokens).not.toBeNull();
  expect(secondTokens!.refreshToken).not.toBe(firstTokens!.refreshToken);

  const oldRefresh = await exchangeToken(t, firstTokens!.refreshToken);
  expect(oldRefresh).toBeNull();

  // Replacing a session emits a `session.invalidated` audit event.
  const events = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.event.list, {
      where: { kind: "session.invalidated" },
      paginationOpts: { numItems: 10, cursor: null },
    });
  });
  expect(events.page.length).toBeGreaterThan(0);
  expect(
    (events.page as Array<{ data?: { reason?: string } }>).some(
      (e) => e.data?.reason === "replaced",
    ),
  ).toBe(true);
});
