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

test("OAuth callback with failed token exchange redirects without code param", async () => {
  setupEnv();
  process.env.AUTH_GITHUB_ID = "githubClientId";
  process.env.AUTH_GITHUB_SECRET = "githubClientSecret";
  const t = convexTest(schema);

  // Start the OAuth flow to get a proper redirect URL and cookies
  const { redirect } = await t.action(api.auth.signIn, {
    provider: "github",
    params: {},
  });

  const url = new URL(redirect!);
  const response = await t.fetch(`${url.pathname}${url.search}`);
  const redirectedTo = response.headers.get("Location");
  const cookies = response.headers.get("Set-Cookie");

  const redirectedToParams = new URL(redirectedTo!).searchParams;
  const callbackUrlStr = redirectedToParams.get("redirect_uri");
  const codeChallenge = redirectedToParams.get("code_challenge");

  // Mock GitHub's token exchange to return an error (e.g., expired OAuth code)
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: "bad_verification_code" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );

  // Hit the callback with valid cookies but a failing token exchange
  const callbackResponse = await t.fetch(
    `${new URL(callbackUrlStr!).pathname}?code=any-oauth-code&code_challenge=${codeChallenge}`,
    {
      headers: {
        Cookie: cookies!
          .split(",")
          .map((cookie) => {
            const [name, value] = cookie.split(";")[0].split("=");
            return `${name}=${value};`;
          })
          .join(" "),
      },
    },
  );

  vi.unstubAllGlobals();

  // Should redirect (302) back to SITE_URL without ?code= or ?error= param
  // (legacy handler returns void for OAuth failures, so no error param)
  expect(callbackResponse.status).toBe(302);
  const location = callbackResponse.headers.get("Location");
  expect(location).not.toBeNull();
  const redirectUrl = new URL(location!);
  expect(redirectUrl.searchParams.has("code")).toBe(false);
  expect(redirectUrl.searchParams.has("error")).toBe(false);
});

// --- Duplicate sign-up: thrown errors ---

test("duplicate sign-up with different password throws Account already exists", async () => {
  setupEnv();
  const t = convexTest(schema);

  await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  await expect(
    t.action(api.auth.signIn, {
      provider: "password",
      params: { email: "sarah@gmail.com", password: "different1", flow: "signUp" },
    }),
  ).rejects.toThrow("Account sarah@gmail.com already exists");
});

// --- Missing required params: thrown errors ---

test("missing password on signUp throws Invalid password", async () => {
  setupEnv();
  const t = convexTest(schema);

  await expect(
    t.action(api.auth.signIn, {
      provider: "password",
      params: { email: "sarah@gmail.com", flow: "signUp" },
    }),
  ).rejects.toThrow("Invalid password");
});

test("missing password on signIn throws", async () => {
  setupEnv();
  const t = convexTest(schema);

  await expect(
    t.action(api.auth.signIn, {
      provider: "password",
      params: { email: "sarah@gmail.com", flow: "signIn" },
    }),
  ).rejects.toThrow("Missing `password` param for `signIn` flow");
});

// --- Provider configuration: thrown errors ---

test("invalid provider name throws", async () => {
  setupEnv();
  const t = convexTest(schema);

  await expect(
    t.action(api.auth.signIn, {
      provider: "nonexistent",
      params: {},
    }),
  ).rejects.toThrow("Provider `nonexistent` is not configured");
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
