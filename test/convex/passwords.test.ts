import { convexTest } from "convex-test";
import { decodeJwt } from "jose";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  AUTH_RESEND_KEY,
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
} from "./test.helpers";

test("sign up and sign in with password", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sara@gmail.com", password: "44448888", flow: "signUp" },
  });

  expect(tokens).not.toBeNull();

  const { tokens: tokens2 } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sara@gmail.com", password: "44448888", flow: "signIn" },
  });

  expect(tokens2).not.toBeNull();

  await expect(async () => {
    await t.action(api.auth.signIn, {
      provider: "password",
      params: { email: "sara@gmail.com", password: "wrong", flow: "signIn" },
    });
  }).rejects.toThrow("Invalid secret");

  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toMatchObject([{ email: "sara@gmail.com" }]);
    const accounts = await ctx.db.query("accounts").collect();
    expect(accounts).toMatchObject([
      { provider: "password", providerAccountId: "sara@gmail.com" },
    ]);
    const sessions = await ctx.db.query("sessions").collect();
    expect(sessions).toHaveLength(2);
  });

  const claims = decodeJwt(tokens.token);
  await t.withIdentity({ subject: claims.sub }).action(api.auth.signOut);

  await t.run(async (ctx) => {
    const sessions = await ctx.db.query("sessions").collect();
    expect(sessions).toHaveLength(1);
  });

  const claims2 = decodeJwt(tokens2.token);
  await t.withIdentity({ subject: claims2.sub }).action(api.auth.signOut);

  await t.run(async (ctx) => {
    const sessions = await ctx.db.query("sessions").collect();
    expect(sessions).toHaveLength(0);
  });
});

function setupEnv() {
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_RESEND_KEY = AUTH_RESEND_KEY;
}
