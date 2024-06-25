import { load as cheerio } from "cheerio";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  AUTH_RESEND_KEY,
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
} from "./test.helpers";

test("rate limit on otp", async () => {
  vi.useFakeTimers();
  setupEnv();
  const t = convexTest(schema);

  // Initiate sign-in via OTP
  let code;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      if (
        typeof input === "string" &&
        input === "https://api.resend.com/emails"
      ) {
        expect(init.headers.get("Authorization")).toBe(
          `Bearer ${process.env.AUTH_RESEND_OTP_KEY}`,
        );
        expect(init.body).toBeTypeOf("string");
        code = cheerio(init.body)("span").text();
        expect(code).not.toEqual("");
        return new Response(JSON.stringify(null), { status: 200 });
      }
      throw new Error("Unexpected fetch");
    }),
  );

  await t.action(api.auth.signIn, {
    provider: "resend-otp",
    params: { email: "tom@gmail.com" },
  });
  vi.unstubAllGlobals();

  const SECOND_MS = 1000;
  const MINUTE_MS = SECOND_MS * 60;

  // First we're gonna fail 10 times quickly
  for (let i = 0; i < 10; i++) {
    vi.advanceTimersByTime(10 * SECOND_MS);
    const { tokens } = await t.action(api.auth.signIn, {
      provider: "resend-otp",
      params: { code: "Aint gonna work", email: "tom@gmail.com" },
    });
    expect(tokens).toBeNull();
  }

  // Now we can't succeed, even with the right code
  const { tokens: rateLimitedTokens } = await t.action(api.auth.signIn, {
    provider: "resend-otp",
    params: { code, email: "tom@gmail.com" },
  });
  expect(rateLimitedTokens).toBeNull();

  // But if we wait a little bit, we can try again
  vi.advanceTimersByTime(8 * MINUTE_MS);

  const { tokens } = await t.action(api.auth.signIn, {
    provider: "resend-otp",
    params: { code, email: "tom@gmail.com" },
  });
  expect(tokens).not.toBeNull();
  vi.useRealTimers();
});

test("rate limit on password", async () => {
  vi.useFakeTimers();
  setupEnv();
  const t = convexTest(schema);

  await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  const SECOND_MS = 1000;
  const MINUTE_MS = SECOND_MS * 60;

  // First we're gonna fail 10 times quickly
  for (let i = 0; i < 10; i++) {
    vi.advanceTimersByTime(10 * SECOND_MS);
    await expect(
      async () =>
        await t.action(api.auth.signIn, {
          provider: "password",
          params: {
            email: "sarah@gmail.com",
            password: "nobueno",
            flow: "signIn",
          },
        }),
    ).rejects.toThrow();
  }

  // Now we can't succeed, even with the right password
  await expect(
    async () =>
      await t.action(api.auth.signIn, {
        provider: "password",
        params: {
          email: "sarah@gmail.com",
          password: "44448888",
          flow: "signIn",
        },
      }),
  ).rejects.toThrow();

  // But if we wait a little bit, we can try again
  vi.advanceTimersByTime(8 * MINUTE_MS);

  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signIn" },
  });
  expect(tokens).not.toBeNull();
  vi.useRealTimers();
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_RESEND_OTP_KEY = AUTH_RESEND_KEY;
}
