import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
  signInViaGitHub,
  startSignInViaGitHub,
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

test("an oauth code redeemed without its verifier is not consumed", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { code, verifier } = await startSignInViaGitHub(t, "github", {
    email: "tom@gmail.com",
    name: "Tom",
    id: "someGitHubId",
  });

  const result = await t.action(api.auth.signIn, { params: { code } });
  expect(result).toEqual({ tokens: null });

  const { tokens } = await t.action(api.auth.signIn, {
    params: { code },
    verifier,
  });
  expect(tokens).not.toBeNull();
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

test("oauth sign in with a verifier id from the wrong table", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { tokens } = await signInViaGitHub(t, "github", {
    email: "tom@gmail.com",
    name: "Tom",
    id: "someGitHubId",
  });
  expect(tokens).not.toBeNull();

  const session = await t.run(async (ctx) => {
    return (await ctx.db.query("authSessions").collect())[0];
  });

  // A well-formed id from another table must not be treated as a verifier.
  const response = await t.fetch(`/api/auth/signin/github?code=${session._id}`);
  expect(response.status).toBe(500);

  await t.run(async (ctx) => {
    const sessionAfter = await ctx.db.get(session._id);
    expect(sessionAfter).toEqual(session);
    const verifiers = await ctx.db.query("authVerifiers").collect();
    expect(verifiers).toHaveLength(0);
  });
});

test("oauth sign in with a malformed verifier", async () => {
  setupEnv();
  const t = convexTest(schema);
  const response = await t.fetch("/api/auth/signin/github?code=notAnId");
  expect(response.status).toBe(500);
  await t.run(async (ctx) => {
    const verifiers = await ctx.db.query("authVerifiers").collect();
    expect(verifiers).toHaveLength(0);
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
