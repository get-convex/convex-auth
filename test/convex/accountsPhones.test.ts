import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
  signInViaPhone,
} from "./test.helpers";

test("automatic linking for signin via phone", async () => {
  setupEnv();
  const t = convexTest(schema);

  // 1. Sign in via phone
  await signInViaPhone(t, "fake-phone", { phone: "+1234567890" });

  // 2. Sign in via the same phone, different provider
  const newTokens = await signInViaPhone(t, "fake-phone-2", {
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

test("no linking to untrusted accounts", async () => {
  setupEnv();
  const t = convexTest(schema);

  // 1. Sign up without phone verification
  await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  // 2. Add a phone number
  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toHaveLength(1);
    expect(users[0].phoneVerificationTime).toBeUndefined();
    await ctx.db.patch(users[0]._id, { phone: "+1234567890" });
  });

  // 2. Sign up via phone
  await signInViaPhone(t, "fake-phone", { phone: "+1234567890" });

  // 3. Check the users and accounts
  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toHaveLength(2);
    expect(users).toMatchObject([
      { phone: "+1234567890", email: "sarah@gmail.com" },
      { phone: "+1234567890" },
    ]);
    const accounts = await ctx.db.query("authAccounts").collect();
    expect(accounts).toHaveLength(2);
    expect(accounts).toMatchObject([
      { provider: "password", userId: users[0]._id },
      { provider: "fake-phone", userId: users[1]._id },
    ]);
  });
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
