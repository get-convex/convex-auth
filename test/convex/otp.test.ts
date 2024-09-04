import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import {
  AUTH_RESEND_KEY,
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
  mockResendOTP,
  signInViaOTP,
} from "./test.helpers";
import { api } from "./_generated/api";

test("sign in with otp", async () => {
  setupEnv();
  const t = convexTest(schema);

  const tokens = await signInViaOTP(t, "resend-otp", {
    email: "tom@gmail.com",
  });

  expect(tokens).not.toBeNull();
});

test("make sure OTP requires email check", async () => {
  setupEnv();
  const t = convexTest(schema);

  const { code } = await mockResendOTP(
    async () =>
      await t.action(api.auth.signIn, {
        provider: "resend-otp",
        params: {
          email: "tom@gmail.com",
        },
      }),
  );

  await expect(
    async () =>
      await t.action(api.auth.signIn, {
        params: { code },
      }),
  ).rejects.toThrowError(
    "Token verification requires an `email` in params of `signIn`",
  );
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_RESEND_OTP_KEY = AUTH_RESEND_KEY;
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
