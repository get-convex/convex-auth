import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
  signInViaMagicLink,
} from "./test.helpers";
import { decodeJwt } from "jose";

test("sign in anonymously", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { tokens } = await t.action(api.auth.signIn, { provider: "anonymous" });
  expect(tokens).not.toBeNull();
});

test.todo("convert anonymous user to permanent", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { tokens } = await t.action(api.auth.signIn, { provider: "anonymous" });
  const claims = decodeJwt(tokens!.token);
  const asAnonymous = t.withIdentity({ subject: claims.sub });
  const newTokens = await signInViaMagicLink(
    asAnonymous,
    "resend",
    "mike@gmail.com",
  );
  expect(newTokens).not.toBeNull();
  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toMatchObject([{ email: "mike@gmail.com" }]);
    expect(users[0]).not.toHaveProperty("isAnonymous");
  });
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
