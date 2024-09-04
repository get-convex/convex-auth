import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import {
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
  signInViaPhone,
} from "./test.helpers";

test("sign in with phone", async () => {
  setupEnv();
  const t = convexTest(schema);
  const tokens = await signInViaPhone(t, "fake-phone", {
    phone: "+1234567890",
  });
  expect(tokens).not.toBeNull();
});

test("repeated signin via phone", async () => {
  setupEnv();
  const t = convexTest(schema);

  // 1. Sign in via phone
  await signInViaPhone(t, "fake-phone", { phone: "+1234567890" });

  // 2. Sign in via the same phone
  const newTokens = await signInViaPhone(t, "fake-phone", {
    phone: "+1234567890",
  });
  expect(newTokens).not.toBeNull();

  // 3. Check that there is only one user, the same one
  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toHaveLength(1);
    expect(users[0].phoneVerificationTime).not.toBeUndefined();
  });
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
