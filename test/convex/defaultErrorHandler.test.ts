import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
  AUTH_RESEND_KEY,
} from "./test.helpers";

// Tests for defaultOnAuthError wired through the signIn action pipeline.
// Uses a second convexAuth() instance (signInDefault) configured with
// handleError: defaultOnAuthError, while sharing the same store mutation.

test("wrong password returns INVALID_CREDENTIALS error code", async () => {
  setupEnv();
  const t = convexTest(schema);

  await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  // With defaultOnAuthError, wrong password returns an error code
  // instead of throwing
  const result = await t.action(api.auth.signInDefault, {
    provider: "password",
    params: {
      email: "sarah@gmail.com",
      password: "wrongpassword",
      flow: "signIn",
    },
  });

  expect(result.error).toBe("INVALID_CREDENTIALS");
  expect(result.tokens).toBeNull();
});

test("non-existent account maps to INVALID_CREDENTIALS", async () => {
  setupEnv();
  const t = convexTest(schema);

  // defaultOnAuthError maps ACCOUNT_NOT_FOUND to INVALID_CREDENTIALS
  // to prevent user enumeration
  const result = await t.action(api.auth.signInDefault, {
    provider: "password",
    params: {
      email: "nobody@gmail.com",
      password: "44448888",
      flow: "signIn",
    },
  });

  expect(result.error).toBe("INVALID_CREDENTIALS");
  expect(result.tokens).toBeNull();
});

test("successful sign-in has no error field", async () => {
  setupEnv();
  const t = convexTest(schema);

  await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  const result = await t.action(api.auth.signInDefault, {
    provider: "password",
    params: {
      email: "sarah@gmail.com",
      password: "44448888",
      flow: "signIn",
    },
  });

  expect(result.tokens).not.toBeNull();
  expect(result.error).toBeUndefined();
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
