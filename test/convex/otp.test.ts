import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import {
  AUTH_RESEND_KEY,
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
  signInViaOTP,
} from "./test.helpers";

test("sign in with otp", async () => {
  setupEnv();
  const t = convexTest(schema);

  const tokens = await signInViaOTP(t, "resend-otp", {
    email: "tom@gmail.com",
  });

  expect(tokens).not.toBeNull();
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_RESEND_OTP_KEY = AUTH_RESEND_KEY;
}
