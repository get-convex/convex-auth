import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { generateAuthKeys, type AuthKeys } from "@convex-dev/auth/server";
import { registerCore } from "@convex-dev/auth/providers/testing/core";
import { registerPasskeyProvider } from "@convex-dev/auth/providers/testing/passkey";
import { registerUsername } from "@convex-dev/auth/providers/testing/username";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");
let keys: AuthKeys;
let otherKeys: AuthKeys;
beforeAll(async () => {
  keys = await generateAuthKeys();
  otherKeys = await generateAuthKeys();
});
afterEach(() => vi.unstubAllEnvs());

function setup(authKeys: AuthKeys) {
  vi.stubEnv("AUTH_PRIVATE_KEY", authKeys.authPrivateKey);
  vi.stubEnv("AUTH_JWKS", authKeys.authJwks);
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  const t = convexTest(schema, modules);
  registerCore(t);
  registerPasskeyProvider(t);
  registerUsername(t);
  return t;
}

// Only register the core for failure tests. Reaching either the username or
// passkey component fails with a missing-component error instead, proving the
// configuration error occurs before lookup or challenge creation.
function setupCoreOnly(authKeys: AuthKeys) {
  vi.stubEnv("AUTH_PRIVATE_KEY", authKeys.authPrivateKey);
  vi.stubEnv("AUTH_JWKS", authKeys.authJwks);
  const t = convexTest(schema, modules);
  registerCore(t);
  return t;
}

describe("passkey configuration preflight", () => {
  test.each(["raw PEM", "mismatched JWKS"])(
    "rejects %s before either ceremony can start",
    async (kind) => {
      const bad =
        kind === "raw PEM"
          ? { ...keys, authPrivateKey: atob(keys.authPrivateKey) }
          : { ...keys, authJwks: otherKeys.authJwks };
      const t = setupCoreOnly(bad);
      const expected =
        kind === "raw PEM"
          ? "AUTH_PRIVATE_KEY must contain base64-encoded PEM"
          : "AUTH_PRIVATE_KEY must match the signing key in AUTH_JWKS";
      await expect(
        t.mutation(api.auth.startSignIn, { username: "alice" }),
      ).rejects.toThrow(expected);
      await expect(
        t.mutation(api.auth.startAutofillSignIn, {}),
      ).rejects.toThrow(expected);
      expect(await t.run((ctx) => ctx.db.query("users").collect())).toEqual([]);
    },
  );

  test("valid keys allow registration and autofill challenges", async () => {
    const t = setup(keys);
    const registration = await t.mutation(api.auth.startSignIn, {
      username: "alice",
    });
    expect(registration).toMatchObject({ success: true, step: "register" });
    const autofill = await t.mutation(api.auth.startAutofillSignIn, {});
    expect(autofill.challenge.byteLength).toBeGreaterThan(0);
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toEqual([]);
  });
});
