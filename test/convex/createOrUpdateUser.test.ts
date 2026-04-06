/// <reference types="vite/client" />
import GitHub from "@auth/core/providers/github";
import { convexTest } from "convex-test";
import { decodeJwt } from "jose";
import { Password } from "../../src/providers/Password";
import { convexAuth } from "../../src/server";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
  signInViaGitHub,
} from "./test.helpers";

const createOrUpdateUserAuth = convexAuth({
  callbacks: {
    async createOrUpdateUser(ctx, args) {
      if (args.existingUserId) {
        return args.existingUserId;
      }

      if (args.authUserId) {
        await ctx.db.insert("messages", {
          userId: args.authUserId,
          body: JSON.stringify({
            type: args.type,
            authUserId: args.authUserId,
            existingUserId: args.existingUserId,
          }),
        });
        return args.authUserId;
      }

      return await ctx.db.insert("users", {
        email: args.profile.email,
        name:
          typeof args.profile.name === "string" ? args.profile.name : undefined,
      });
    },
  },
  providers: [GitHub, Password],
});

test("createOrUpdateUser links a new OAuth account to the signed-in user via authUserId", async () => {
  setupEnv();
  const modules = import.meta.glob("./**/*.*s");
  const overriddenModules = {
    ...modules,
    "./auth.ts": async () => createOrUpdateUserAuth,
  };
  const t = convexTest(schema, overriddenModules);

  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });
  expect(tokens).not.toBeNull();

  const claims = decodeJwt(tokens!.token);
  const asSarah = t.withIdentity({ subject: claims.sub });

  const { tokens: oauthTokens } = await signInViaGitHub(asSarah, "github", {
    email: "github-only@example.com",
    name: "Sarah From GitHub",
    id: "someGitHubId",
  });
  expect(oauthTokens).not.toBeNull();

  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toHaveLength(1);

    const accounts = await ctx.db.query("authAccounts").collect();
    expect(accounts).toHaveLength(2);
    expect(accounts.find((account) => account.provider === "password")).toMatchObject({
      userId: users[0]._id,
    });
    expect(accounts.find((account) => account.provider === "github")).toMatchObject({
      userId: users[0]._id,
    });

    const messages = await ctx.db.query("messages").collect();
    expect(messages).toHaveLength(1);
    expect(messages[0].userId).toEqual(users[0]._id);
    expect(JSON.parse(messages[0].body)).toEqual({
      type: "oauth",
      authUserId: users[0]._id,
      existingUserId: null,
    });
  });
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_GITHUB_ID = "githubClientId";
  process.env.AUTH_GITHUB_SECRET = "githubClientSecret";
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
