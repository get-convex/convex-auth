import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { api } from "./_generated/api.js";
import { registerCore } from "@convex-dev/auth/providers/testing/core";
import { registerPasswordProvider } from "@convex-dev/auth/providers/testing/password";
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

type PasswordResult =
  Awaited<ReturnType<typeof signUp>> | Awaited<ReturnType<typeof signIn>>;
type PasswordSuccess = Extract<PasswordResult, { success: true }>;

describe("setupUsernamePassword", () => {
  test("signs up a new user and returns a session", async () => {
    const t = await setup();
    const result = await signUp(t, "alice", PASSWORD);
    expect(result).toEqual({
      success: true,
      tokens: {
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(Number),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
  });

  test("signs in with the correct password", async () => {
    const t = await setup();
    const up = await signUp(t, "alice", PASSWORD);
    const inResult = await signIn(t, "alice", PASSWORD);
    expect(up).toEqual({
      success: true,
      tokens: {
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(Number),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
    expect(inResult).toEqual({
      success: true,
      tokens: {
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(Number),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
    // Same identity → same app user id.
    expect((inResult as PasswordSuccess).tokens.userId).toBe(
      (up as PasswordSuccess).tokens.userId,
    );
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
    expect(up).toEqual({
      success: true,
      tokens: {
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(Number),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });

    // A different casing is treated as the same account for both sign-in...
    const inResult = await signIn(t, "ALICE", PASSWORD);
    expect(inResult).toEqual({
      success: true,
      tokens: {
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(Number),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
    expect((inResult as PasswordSuccess).tokens.userId).toBe(
      (up as PasswordSuccess).tokens.userId,
    );

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
    expect(up).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });

    // No account was created, so a later sign-up with a valid password works.
    const retry = await signUp(t, "alice", PASSWORD);
    expect(retry).toEqual({
      success: true,
      tokens: {
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(Number),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
  });
});
