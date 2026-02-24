import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { CONVEX_SITE_URL, JWKS, JWT_PRIVATE_KEY } from "./test.helpers";

test("beforeSessionCreation allows sign-in for non-banned user", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  expect(tokens).not.toBeNull();
});

test("beforeSessionCreation rejects sign-in for banned user", async () => {
  setupEnv();
  const t = convexTest(schema);

  // Sign up first
  await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  // Ban the user
  await t.run(async (ctx) => {
    const user = (await ctx.db.query("users").collect())[0];
    await ctx.db.patch(user._id, { banned: true });
  });

  // Sign in should be rejected
  await expect(async () => {
    await t.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: "sarah@gmail.com",
        password: "44448888",
        flow: "signIn",
      },
    });
  }).rejects.toThrow("Account is banned");
});

test("beforeSessionCreation rejects sign-up for banned user on subsequent sign-up attempt", async () => {
  setupEnv();
  const t = convexTest(schema);

  // Sign up first
  await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  // Ban the user
  await t.run(async (ctx) => {
    const user = (await ctx.db.query("users").collect())[0];
    await ctx.db.patch(user._id, { banned: true });
  });

  // Attempting to sign up again with same email should also be rejected
  // since the user already exists and the callback fires before session creation
  await expect(async () => {
    await t.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: "sarah@gmail.com",
        password: "44448888",
        flow: "signUp",
      },
    });
  }).rejects.toThrow("Account is banned");
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
