import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { CONVEX_SITE_URL, JWKS, JWT_PRIVATE_KEY } from "./test.helpers";

test("sign in anonymously", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { tokens } = await t.action(api.auth.signIn, { provider: "anonymous" });
  expect(tokens).not.toBeNull();
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
}
