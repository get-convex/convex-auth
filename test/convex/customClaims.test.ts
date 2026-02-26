import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { CONVEX_SITE_URL, JWKS, JWT_PRIVATE_KEY } from "./test.helpers";
import { decodeJwt } from "jose";

test("custom claims are included in JWT", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });
  expect(tokens).not.toBeNull();

  const claims = decodeJwt(tokens!.token);
  expect(claims.email).toBe("sarah@gmail.com");
});

test("reserved claims in customClaims throw an error", async () => {
  setupEnv();
  const modules = import.meta.glob("./**/*.*s");
  const overriddenModules = {
    ...modules,
    "./auth.ts": () => import("./authReservedClaims"),
  };
  const t = convexTest(schema, overriddenModules);
  await expect(
    t.action(api.auth.signIn, {
      provider: "password",
      params: {
        email: "sarah@gmail.com",
        password: "44448888",
        flow: "signUp",
      },
    }),
  ).rejects.toThrow('Reserved claim "sub" in custom claims');
});

test("token refresh picks up updated claims", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });
  expect(tokens).not.toBeNull();

  const initialClaims = decodeJwt(tokens!.token);
  expect(initialClaims.email).toBe("sarah@gmail.com");

  // Update the user's email directly in the database
  await t.run(async (ctx) => {
    const user = (await ctx.db.query("users").collect())[0];
    await ctx.db.patch(user._id, { email: "newemail@gmail.com" });
  });

  // Refresh the token
  const { tokens: refreshedTokens } = await t.action(api.auth.signIn, {
    refreshToken: tokens!.refreshToken,
    params: {},
  });
  expect(refreshedTokens).not.toBeNull();

  const refreshedClaims = decodeJwt(refreshedTokens!.token);
  expect(refreshedClaims.email).toBe("newemail@gmail.com");
});

test("undefined claim values are silently dropped", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });
  expect(tokens).not.toBeNull();

  // Clear the user's email so customClaims returns { email: undefined }
  await t.run(async (ctx) => {
    const user = (await ctx.db.query("users").collect())[0];
    await ctx.db.patch(user._id, { email: undefined });
  });

  // Refresh the token to get new claims
  const { tokens: refreshedTokens } = await t.action(api.auth.signIn, {
    refreshToken: tokens!.refreshToken,
    params: {},
  });
  expect(refreshedTokens).not.toBeNull();

  const refreshedClaims = decodeJwt(refreshedTokens!.token);
  expect(refreshedClaims).not.toHaveProperty("email");
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
