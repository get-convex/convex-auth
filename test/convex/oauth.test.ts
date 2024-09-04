import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import {
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
  signInViaGitHub,
} from "./test.helpers";

test("sign up with oauth", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { tokens } = await signInViaGitHub(t, "github", {
    email: "tom@gmail.com",
    name: "Tom",
    id: "someGitHubId",
  });

  expect(tokens).not.toBeNull();

  await t.run(async (ctx) => {
    const verificationCodes = await ctx.db
      .query("authVerificationCodes")
      .collect();
    expect(verificationCodes).toHaveLength(0);
    const verifiers = await ctx.db.query("authVerifiers").collect();
    expect(verifiers).toHaveLength(0);
  });
});

test("sign in with oauth", async () => {
  setupEnv();
  const t = convexTest(schema);
  await signInViaGitHub(t, "github", {
    email: "tom@gmail.com",
    name: "Tom",
    id: "someGitHubId",
  });

  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toMatchObject([{ email: "tom@gmail.com", name: "Tom" }]);
  });

  const { tokens } = await signInViaGitHub(t, "github", {
    email: "tom@gmail.com",
    name: "Thomas",
    id: "someGitHubId",
  });

  expect(tokens).not.toBeNull();

  await t.run(async (ctx) => {
    const verificationCodes = await ctx.db
      .query("authVerificationCodes")
      .collect();
    expect(verificationCodes).toHaveLength(0);
    const verifiers = await ctx.db.query("authVerifiers").collect();
    expect(verifiers).toHaveLength(0);
    const users = await ctx.db.query("users").collect();
    expect(users).toMatchObject([{ email: "tom@gmail.com", name: "Thomas" }]);
  });
});

test("redirectTo with oauth", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { url } = await signInViaGitHub(
    t,
    "github",
    {
      email: "tom@gmail.com",
      name: "Tom",
      id: "someGitHubId",
    },
    { redirectTo: "/dashboard" },
  );

  expect(url).toEqual(
    expect.stringContaining("http://localhost:5173/dashboard"),
  );
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
