import { convexTest } from "convex-test";
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

test("refresh token reuse detection", async () => {
  vi.useFakeTimers();
  setupEnv();

  const t = convexTest(schema);
  const { tokens: initialTokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });
  const { refreshToken } = initialTokens!;

  const { tokens: newTokens } = await t.action(api.auth.signIn, {
    refreshToken,
    params: {},
  });
  expect(newTokens).not.toBeNull();

  const { tokens: reuseResponse } = await t.action(api.auth.signIn, {
    refreshToken,
    params: {},
  });
  expect(reuseResponse).toBeNull();

  const { tokens: newTokenResponse } = await t.action(api.auth.signIn, {
    refreshToken: newTokens!.refreshToken,
    params: {},
  });

  expect(newTokenResponse).toBeNull();

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
}
