import { convexTest } from "convex-test";
import { describe, expect, test, vi, afterEach } from "vitest";
import { api } from "./_generated/api.js";
import { registerAnonymousProvider } from "@convex-dev/auth/providers/testing/anonymous.js";
import { registerCore } from "@convex-dev/auth/providers/testing/core.js";
import schema from "./schema.js";
import { generateKeyPair, exportPKCS8, exportJWK, decodeJwt } from "jose";
import { randomUUID } from "crypto";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const privatePem = await exportPKCS8(privateKey);
  const pubJwk = await exportJWK(publicKey);
  const kid = randomUUID();

  const authPrivateKey = Buffer.from(privatePem).toString("base64");
  const authJwks = JSON.stringify({
    keys: [{ ...pubJwk, kid, alg: "RS256", use: "sig" }],
  });

  vi.stubEnv("AUTH_PRIVATE_KEY", authPrivateKey);
  vi.stubEnv("AUTH_JWKS", authJwks);
  vi.stubEnv("CONVEX_SITE_URL", "http://localhost:8080/");
  const t = convexTest(schema, modules);
  registerCore(t);
  registerAnonymousProvider(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("anonymous sign in", () => {
  test("returns token bundle", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.signInAnonymous, {});
    expect(result.userId).not.toBe(null);
    expect(result.accessToken).not.toBe(null);
    expect(result.accessTokenExpiresAt).not.toBe(null);
    expect(result.refreshToken).not.toBe(null);
    expect(result.refreshTokenExpiresAt).not.toBe(null);
    expect(result.refreshTokenExpiresAt).toBeGreaterThan(
      result.accessTokenExpiresAt,
    );
  });

  test("returned access token is valid JWT", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.signInAnonymous, {});
    const jwt = decodeJwt(result.accessToken);
    expect(jwt.sub).toBe(result.userId);
  });
});
