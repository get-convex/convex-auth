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
  process.env.TEST_CUSTOM_CLAIMS_RESERVED = "true";
  const t = convexTest(schema);
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
  delete process.env.TEST_CUSTOM_CLAIMS_RESERVED;
});

function setupEnv() {
  delete process.env.TEST_CUSTOM_CLAIMS_RESERVED;
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
