import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  AUTH_RESEND_KEY,
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
  mockResendOTP,
} from "./test.helpers";

// --- Credentials / Password: thrown errors ---

test("wrong password throws InvalidSecret", async () => {
  setupEnv();
  const t = convexTest(schema);

  await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  await expect(
    t.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: "sarah@gmail.com",
        password: "wrongpassword",
        flow: "signIn",
      },
    }),
  ).rejects.toThrow("InvalidSecret");
});

test("sign in to nonexistent account throws InvalidAccountId", async () => {
  setupEnv();
  const t = convexTest(schema);

  await expect(
    t.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: "nobody@gmail.com",
        password: "44448888",
        flow: "signIn",
      },
    }),
  ).rejects.toThrow("InvalidAccountId");
});

test("password rate limit throws TooManyFailedAttempts", async () => {
  vi.useFakeTimers();
  setupEnv();
  const t = convexTest(schema);

  await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  const SECOND_MS = 1000;

  // Fail 10 times
  for (let i = 0; i < 10; i++) {
    vi.advanceTimersByTime(10 * SECOND_MS);
    await expect(
      t.action(api.auth.signIn, {
        provider: "password",
        params: {
          email: "sarah@gmail.com",
          password: "nobueno",
          flow: "signIn",
        },
      }),
    ).rejects.toThrow("InvalidSecret");
  }

  // 11th attempt with correct password — rate limited
  await expect(
    t.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: "sarah@gmail.com",
        password: "44448888",
        flow: "signIn",
      },
    }),
  ).rejects.toThrow("TooManyFailedAttempts");

  vi.useRealTimers();
});

// --- OTP: thrown errors ---

test("wrong OTP code throws Could not verify code", async () => {
  setupEnv();
  const t = convexTest(schema);

  await mockResendOTP(
    async () =>
      await t.action(api.auth.signIn, {
        provider: "resend-otp",
        params: { email: "tom@gmail.com" },
      }),
  );

  await expect(
    t.action(api.auth.signIn, {
      provider: "resend-otp",
      params: { code: "wrong-code", email: "tom@gmail.com" },
    }),
  ).rejects.toThrow("Could not verify code");
});

test("OTP rate limit throws Could not verify code", async () => {
  vi.useFakeTimers();
  setupEnv();
  const t = convexTest(schema);

  const { code } = await mockResendOTP(
    async () =>
      await t.action(api.auth.signIn, {
        provider: "resend-otp",
        params: { email: "tom@gmail.com" },
      }),
  );

  const SECOND_MS = 1000;

  // Fail 10 times
  for (let i = 0; i < 10; i++) {
    vi.advanceTimersByTime(10 * SECOND_MS);
    await expect(
      t.action(api.auth.signIn, {
        provider: "resend-otp",
        params: { code: "wrong-code", email: "tom@gmail.com" },
      }),
    ).rejects.toThrow("Could not verify code");
  }

  // 11th attempt with correct code — rate limited, same error message
  await expect(
    t.action(api.auth.signIn, {
      provider: "resend-otp",
      params: { code, email: "tom@gmail.com" },
    }),
  ).rejects.toThrow("Could not verify code");

  vi.useRealTimers();
});

// --- Refresh token: silent failures ---

test("expired refresh token returns tokens null silently", async () => {
  vi.useFakeTimers();
  setupEnv();
  const ONE_DAY_MS = 1000 * 60 * 60 * 24;
  process.env.AUTH_SESSION_INACTIVE_DURATION_MS = `${ONE_DAY_MS}`;
  const t = convexTest(schema);

  const { tokens: initialTokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  vi.advanceTimersByTime(2 * ONE_DAY_MS);

  const result = await t.action(api.auth.signIn, {
    refreshToken: initialTokens!.refreshToken,
    params: {},
  });

  // Should return tokens: null without throwing
  expect(result.tokens).toBeNull();
  vi.useRealTimers();
});

test("expired session returns tokens null silently", async () => {
  vi.useFakeTimers();
  setupEnv();
  const ONE_DAY_MS = 1000 * 60 * 60 * 24;
  process.env.AUTH_SESSION_TOTAL_DURATION_MS = `${ONE_DAY_MS}`;
  const t = convexTest(schema);

  const { tokens: initialTokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  vi.advanceTimersByTime(2 * ONE_DAY_MS);

  const result = await t.action(api.auth.signIn, {
    refreshToken: initialTokens!.refreshToken,
    params: {},
  });

  // Should return tokens: null without throwing
  expect(result.tokens).toBeNull();
  vi.useRealTimers();
});

// --- No-provider code exchange: silent failures ---

test("invalid magic link code returns tokens null silently", async () => {
  setupEnv();
  const t = convexTest(schema);

  const result = await t.action(api.auth.signIn, {
    params: { code: "totally-invalid-code" },
  });

  // Should return tokens: null without throwing
  expect(result.tokens).toBeNull();
});

// --- OTP: expired code ---

test("expired OTP code throws Could not verify code", async () => {
  vi.useFakeTimers();
  setupEnv();
  const t = convexTest(schema);

  const { code } = await mockResendOTP(
    async () =>
      await t.action(api.auth.signIn, {
        provider: "resend-otp",
        params: { email: "tom@gmail.com" },
      }),
  );

  // Advance past 24-hour default expiration
  const TWENTY_FIVE_HOURS_MS = 1000 * 60 * 60 * 25;
  vi.advanceTimersByTime(TWENTY_FIVE_HOURS_MS);

  await expect(
    t.action(api.auth.signIn, {
      provider: "resend-otp",
      params: { code, email: "tom@gmail.com" },
    }),
  ).rejects.toThrow("Could not verify code");

  vi.useRealTimers();
});

// --- Credentials authorize returns null: silent failure ---

test("credentials authorize returning null returns tokens null silently", async () => {
  setupEnv();
  const t = convexTest(schema);

  const result = await t.action(api.auth.signIn, {
    provider: "test-null-authorize",
    params: {},
  });

  // Should return tokens: null without throwing
  expect(result.tokens).toBeNull();
});

// --- OAuth callback: silent redirect on failure ---

test("OAuth callback failure redirects without code param", async () => {
  setupEnv();
  process.env.AUTH_GITHUB_ID = "githubClientId";
  process.env.AUTH_GITHUB_SECRET = "githubClientSecret";
  const t = convexTest(schema);

  // Hit the OAuth callback directly with no valid state/cookies
  // This simulates a failed OAuth callback (e.g., invalid token exchange)
  const response = await t.fetch(
    "/api/auth/callback/github?code=invalid-oauth-code",
  );

  // Should redirect (302) back to SITE_URL without ?code= param
  expect(response.status).toBe(302);
  const location = response.headers.get("Location");
  expect(location).not.toBeNull();
  const redirectUrl = new URL(location!);
  expect(redirectUrl.searchParams.has("code")).toBe(false);
});

// --- Password validation errors ---

test("password too short throws on signUp", async () => {
  setupEnv();
  const t = convexTest(schema);

  await expect(
    t.action(api.auth.signIn, {
      provider: "password",
      params: { email: "sarah@gmail.com", password: "short", flow: "signUp" },
    }),
  ).rejects.toThrow("Invalid password");
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_RESEND_KEY = AUTH_RESEND_KEY;
  process.env.AUTH_RESEND_OTP_KEY = AUTH_RESEND_KEY;
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
