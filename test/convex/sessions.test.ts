import { convexTest, TestConvex } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { CONVEX_SITE_URL, JWKS, JWT_PRIVATE_KEY } from "./test.helpers";

test("session refresh", async () => {
  vi.useFakeTimers();
  setupEnv();
  const t = convexTest(schema);
  const { tokens: initialTokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });
  const { refreshToken } = initialTokens!;

  const TWO_HOURS_MS = 1000 * 60 * 60 * 2;
  vi.advanceTimersByTime(TWO_HOURS_MS);

  const { tokens } = await t.action(api.auth.signIn, {
    refreshToken,
    params: {},
  });

  expect(tokens).not.toBeNull();

  vi.useRealTimers();
});

test("refresh token expiration", async () => {
  vi.useFakeTimers();
  setupEnv();
  const ONE_DAY_MS = 1000 * 60 * 60 * 24;
  process.env.AUTH_SESSION_INACTIVE_DURATION_MS = `${ONE_DAY_MS}`;
  const t = convexTest(schema);
  const { tokens: initialTokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });
  const { refreshToken } = initialTokens!;

  vi.advanceTimersByTime(2 * ONE_DAY_MS);

  const { tokens } = await t.action(api.auth.signIn, {
    refreshToken,
    params: {},
  });

  expect(tokens).toBeNull();

  vi.useRealTimers();
});

async function exchangeToken(
  t: TestConvex<typeof schema>,
  refreshToken: string,
) {
  const { tokens: newTokens } = await t.action(api.auth.signIn, {
    refreshToken,
    params: {},
  });
  return newTokens?.refreshToken ?? null;
}

test("refresh token reuse detection", async () => {
  vi.useFakeTimers();
  setupEnv();

  const t = convexTest(schema);
  const { tokens: initialTokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });
  const { refreshToken: refreshTokenA } = initialTokens!;

  const refreshTokenB = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB).not.toBeNull();

  // Advance time within the reuse window (10 seconds)
  vi.advanceTimersByTime(5000);

  const refreshTokenB1 = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB1).not.toBeNull();
  // Token A is the parent of active refresh token B, so the same token should
  // be returned
  expect(refreshTokenB1).toEqual(refreshTokenB);

  // Advance time again to be outside of the reuse window
  vi.advanceTimersByTime(5001);

  const refreshTokenB2 = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB2).not.toBeNull();
  // Even though we're outside of the reuse window, the same refresh token
  // should be returned because B1 is the active refresh token
  expect(refreshTokenB2).toEqual(refreshTokenB1);

  const refreshTokenC = await exchangeToken(t, refreshTokenB!);
  expect(refreshTokenC).not.toBeNull();

  const refreshTokenB3 = await exchangeToken(t, refreshTokenA);
  // Now that B is no longer the active refresh token, and we're outside of the refresh window
  // we cannot use token A
  expect(refreshTokenB3).toBeNull();

  const refreshTokenD = await exchangeToken(t, refreshTokenC!);
  // Since C descends from A, and A was used outside of the refresh window, we also
  // cannot use C
  expect(refreshTokenD).toBeNull();

  vi.useRealTimers();
});

test("refresh token reuse with racing requests", async () => {
  vi.useFakeTimers();
  setupEnv();

  const t = convexTest(schema);
  const { tokens: initialTokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });
  const { refreshToken: refreshTokenA } = initialTokens!;

  const refreshTokenB = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB).not.toBeNull();

  // Advance time within the reuse window (10 seconds)
  vi.advanceTimersByTime(5000);

  const refreshTokenB1 = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB1).not.toBeNull();
  // Token A is the parent of active refresh token B, so the same token should
  // be returned
  expect(refreshTokenB1).toEqual(refreshTokenB);

  // Regression test: Token B is still usable even after a second request to exchange
  // token A is made.
  // In this case, it's because Token B and Token B1 are the same.
  const refreshTokenC = await exchangeToken(t, refreshTokenB!);
  expect(refreshTokenC).not.toBeNull();

  const refreshTokenC1 = await exchangeToken(t, refreshTokenB1!);
  expect(refreshTokenC1).not.toBeNull();

  vi.useRealTimers();
});

test("refresh token invalidate subtree", async () => {
  vi.useFakeTimers();
  setupEnv();

  const t = convexTest(schema);
  const { tokens: initialTokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });
  const { refreshToken: refreshTokenA } = initialTokens!;

  const refreshTokenB = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB).not.toBeNull();

  const refreshTokenC = await exchangeToken(t, refreshTokenB!);
  expect(refreshTokenC).not.toBeNull();

  // Advance time within the reuse window (10 seconds)
  vi.advanceTimersByTime(5000);

  const refreshTokenB1 = await exchangeToken(t, refreshTokenA);
  expect(refreshTokenB1).not.toBeNull();

  // Still within the reuse window for token A, but token B is no longer the active
  // refresh token, so we should get a new refresh token
  expect(refreshTokenB1).not.toEqual(refreshTokenB);

  const refreshTokenC1 = await exchangeToken(t, refreshTokenB1!);
  expect(refreshTokenC1).not.toBeNull();

  // Advance time again to be outside of the reuse window for token B
  vi.advanceTimersByTime(5001);

  // Token B is outside of its refresh window. Its subtree should be invalidated.
  const refreshResultB = await exchangeToken(t, refreshTokenB!);
  expect(refreshResultB).toBeNull();

  // Token C cannot be used because it descends from B, which is invalid.
  const refreshResultC = await exchangeToken(t, refreshTokenC!);
  expect(refreshResultC).toBeNull();

  // Token C1 is still valid because it does not descend from B
  const refreshTokenD1 = await exchangeToken(t, refreshTokenC1!);
  expect(refreshTokenD1).not.toBeNull();

  // Token B1 is still valid because it does not descend from B, and is still within the reuse window
  const refreshTokenC2 = await exchangeToken(t, refreshTokenB1!);
  expect(refreshTokenC2).not.toBeNull();

  vi.useRealTimers();
});

test("session expiration", async () => {
  vi.useFakeTimers();
  setupEnv();
  const ONE_DAY_MS = 1000 * 60 * 60 * 24;
  process.env.AUTH_SESSION_TOTAL_DURATION_MS = `${ONE_DAY_MS}`;
  const t = convexTest(schema);
  const { tokens: initialTokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });
  const { refreshToken } = initialTokens!;

  vi.advanceTimersByTime(2 * ONE_DAY_MS);

  const { tokens: refreshedTokens } = await t.action(api.auth.signIn, {
    refreshToken,
    params: {},
  });

  expect(refreshedTokens).toBeNull();

  vi.useRealTimers();
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
