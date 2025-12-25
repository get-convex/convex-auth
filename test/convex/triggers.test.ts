import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  AUTH_RESEND_KEY,
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
  mockResendOTP,
} from "./test.helpers";

test("triggers fire on user and account creation", async () => {
  setupEnv();
  const t = convexTest(schema);

  // Sign up creates a user and account
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "trigger-test@example.com", password: "testpass123", flow: "signUp" },
  });

  expect(tokens).not.toBeNull();

  // Verify triggers fired
  await t.run(async (ctx) => {
    const logs = await ctx.db.query("triggerLog").collect();

    // Should have exactly one onCreate for both users and authAccounts
    const userCreateLogs = logs.filter((l) => l.trigger === "users:onCreate");
    const accountCreateLogs = logs.filter((l) => l.trigger === "authAccounts:onCreate");

    expect(userCreateLogs).toHaveLength(1);
    expect(accountCreateLogs).toHaveLength(1);

    // Verify exactly one user and account were created
    const users = await ctx.db.query("users").collect();
    const accounts = await ctx.db.query("authAccounts").collect();

    expect(users).toHaveLength(1);
    expect(accounts).toHaveLength(1);

    // Verify the docIds match
    expect(userCreateLogs[0].docId).toBe(users[0]._id);
    expect(accountCreateLogs[0].docId).toBe(accounts[0]._id);
  });
});

test("triggers fire on user update during second sign-in", async () => {
  setupEnv();
  const t = convexTest(schema);

  // First sign up (creates user and account)
  await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "update-test@example.com", password: "testpass123", flow: "signUp" },
  });

  // Verify only onCreate triggers fired, no onUpdate yet
  await t.run(async (ctx) => {
    const logs = await ctx.db.query("triggerLog").collect();
    const userCreateLogs = logs.filter((l) => l.trigger === "users:onCreate");
    const userUpdateLogs = logs.filter((l) => l.trigger === "users:onUpdate");

    expect(userCreateLogs).toHaveLength(1);
    expect(userUpdateLogs).toHaveLength(0);
  });

  // Sign in again (updates the user)
  await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "update-test@example.com", password: "testpass123", flow: "signIn" },
  });

  // Verify onUpdate trigger fired
  await t.run(async (ctx) => {
    const logs = await ctx.db.query("triggerLog").collect();
    const userUpdateLogs = logs.filter((l) => l.trigger === "users:onUpdate");

    // Should have exactly one user (same user updated, not a new one)
    const users = await ctx.db.query("users").collect();
    expect(users).toHaveLength(1);

    // Should have at least one onUpdate trigger from sign-in
    expect(userUpdateLogs.length).toBeGreaterThanOrEqual(1);

    // Verify oldDocId is set and matches the user
    expect(userUpdateLogs[0].oldDocId).toBe(users[0]._id);
  });
});

test("triggers fire on password change", async () => {
  setupEnv();
  const t = convexTest(schema);

  // Sign up with password-with-reset provider
  await t.action(api.auth.signIn, {
    provider: "password-with-reset",
    params: { email: "password-change@example.com", password: "oldpass123", flow: "signUp" },
  });

  // Verify onCreate triggers fired for sign-up
  await t.run(async (ctx) => {
    const logs = await ctx.db.query("triggerLog").collect();
    const userCreateLogs = logs.filter((l) => l.trigger === "users:onCreate");
    const accountCreateLogs = logs.filter((l) => l.trigger === "authAccounts:onCreate");

    expect(userCreateLogs).toHaveLength(1);
    expect(accountCreateLogs).toHaveLength(1);

    // No onUpdate yet
    const accountUpdateLogs = logs.filter((l) => l.trigger === "authAccounts:onUpdate");
    expect(accountUpdateLogs).toHaveLength(0);
  });

  // Request password reset (sends code)
  const { code } = await mockResendOTP(async () => {
    await t.action(api.auth.signIn, {
      provider: "password-with-reset",
      params: { email: "password-change@example.com", flow: "reset" },
    });
  });

  // Complete password reset with new password
  await t.action(api.auth.signIn, {
    provider: "password-with-reset",
    params: {
      email: "password-change@example.com",
      code,
      newPassword: "newpass456",
      flow: "reset-verification",
    },
  });

  // Verify authAccounts:onUpdate trigger fired for password change
  await t.run(async (ctx) => {
    const logs = await ctx.db.query("triggerLog").collect();
    const accountUpdateLogs = logs.filter((l) => l.trigger === "authAccounts:onUpdate");

    // Should have exactly one account
    const accounts = await ctx.db.query("authAccounts").collect();
    expect(accounts).toHaveLength(1);

    // Password change should trigger onUpdate for the account
    expect(accountUpdateLogs.length).toBeGreaterThanOrEqual(1);
    expect(accountUpdateLogs[0].docId).toBe(accounts[0]._id);
  });
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_RESEND_KEY = AUTH_RESEND_KEY;
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
