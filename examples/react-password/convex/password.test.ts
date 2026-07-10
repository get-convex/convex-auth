import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { api } from "./_generated/api.js";
import { registerCore } from "@convex-dev/auth/providers/testing/core.js";
import { registerPasswordProvider } from "@convex-dev/auth-password/testing";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const PASSWORD = "correct horse battery staple"; // 28 chars, valid

async function setup() {
  // The core signs JWTs from these env vars (see core/public.ts). Mint a real
  // RS256 key pair for each test and stub the env so Vitest can reset it.
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const pkcs8 = await exportPKCS8(privateKey);
  const publicJwk = await exportJWK(publicKey);

  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("AUTH_PRIVATE_KEY", btoa(pkcs8));
  vi.stubEnv(
    "AUTH_JWKS",
    JSON.stringify({
      keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }],
    }),
  );

  const t = convexTest(schema, modules);
  registerCore(t);
  registerPasswordProvider(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const signUp = (
  t: Awaited<ReturnType<typeof setup>>,
  username: string,
  password: string,
) => t.action(api.auth.signUpWithPassword, { username, password });

const signIn = (
  t: Awaited<ReturnType<typeof setup>>,
  username: string,
  password: string,
) => t.action(api.auth.signInWithPassword, { username, password });

describe("setupUsernamePassword", () => {
  test("signs up a new user and returns a session", async () => {
    const t = await setup();
    const result = await signUp(t, "alice", PASSWORD);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.tokens.userId).toBeTruthy();
    expect(result.tokens.accessToken).toBeTruthy();
    expect(result.tokens.refreshToken).toBeTruthy();
  });

  test("signs in with the correct password", async () => {
    const t = await setup();
    const up = await signUp(t, "alice", PASSWORD);
    const inResult = await signIn(t, "alice", PASSWORD);
    expect(inResult.success).toBe(true);
    if (!inResult.success || !up.success) throw new Error("expected success");
    // Same identity → same app user id.
    expect(inResult.tokens.userId).toBe(up.tokens.userId);
  });

  test("rejects a wrong password with INVALID_CREDENTIALS", async () => {
    const t = await setup();
    await signUp(t, "alice", PASSWORD);
    const result = await signIn(t, "alice", "wrong horse battery staple");
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("rejects an unknown username with USER_NOT_FOUND", async () => {
    const t = await setup();
    const result = await signIn(t, "nobody", PASSWORD);
    expect(result).toEqual({
      success: false,
      userError: { error: "USER_NOT_FOUND" },
    });
  });

  test("rejects signing up a taken username", async () => {
    const t = await setup();
    await signUp(t, "alice", PASSWORD);
    const result = await signUp(t, "alice", PASSWORD);
    expect(result).toEqual({
      success: false,
      userError: { error: "USERNAME_TAKEN" },
    });
  });

  test("usernames are case-insensitive", async () => {
    const t = await setup();
    const up = await signUp(t, "Alice", PASSWORD);
    if (!up.success) throw new Error("expected success");

    // A different casing is treated as the same account for both sign-in...
    const inResult = await signIn(t, "ALICE", PASSWORD);
    expect(inResult.success).toBe(true);
    if (!inResult.success) throw new Error("expected success");
    expect(inResult.tokens.userId).toBe(up.tokens.userId);

    // ...and the taken-username check.
    const dup = await signUp(t, "alice", PASSWORD);
    expect(dup).toEqual({
      success: false,
      userError: { error: "USERNAME_TAKEN" },
    });
  });

  test("rejects a too-short password at sign-up without creating an account", async () => {
    const t = await setup();
    const up = await signUp(t, "alice", "short");
    expect(up.success).toBe(false);
    if (up.success) throw new Error("expected failure");
    expect(up.userError.error).toBe("PASSWORD_TOO_SHORT");

    // No account was created, so a later sign-up with a valid password works.
    const retry = await signUp(t, "alice", PASSWORD);
    expect(retry.success).toBe(true);
  });
});
