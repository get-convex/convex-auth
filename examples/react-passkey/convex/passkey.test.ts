import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { registerCore } from "@convex-dev/auth/providers/testing/core";
import {
  createTestAuthenticator,
  registerPasskeyProvider,
  type TestCredential,
} from "@convex-dev/auth/providers/testing/passkey";
import { registerUsername } from "@convex-dev/auth/providers/testing/username";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

// The relying party of `convex/auth.ts`. A ceremony that names another one
// fails verification.
const authenticator = createTestAuthenticator({
  rpId: "localhost",
  origin: "http://localhost:5173",
});

type T = TestConvex<typeof schema>;

async function setup(): Promise<T> {
  // The core signs JWTs from these env vars (see core/public.ts). Mint a real
  // RS256 key pair for each test and stub the env so Vitest can reset it.
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);

  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("AUTH_PRIVATE_KEY", btoa(await exportPKCS8(privateKey)));
  vi.stubEnv(
    "AUTH_JWKS",
    JSON.stringify({
      keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }],
    }),
  );

  const t = convexTest(schema, modules);
  registerCore(t);
  registerPasskeyProvider(t);
  registerUsername(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The caller as a signed-in user, the way an access token identifies one. */
const as = (t: T, userId: string) => t.withIdentity({ subject: userId });

/** Assert that two byte buffers hold the same bytes. */
function expectSameBytes(a: ArrayBuffer, b: ArrayBuffer | Uint8Array): void {
  expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
}

/** Create an account with its first passkey, the way the log-in page does. */
async function signUp(
  t: T,
  username: string,
): Promise<{ userId: string; credential: TestCredential }> {
  const start = await t.mutation(api.auth.startSignIn, { username });
  if (!start.success || start.step !== "register") {
    throw new Error("The username is not free.");
  }
  const credential = await authenticator.createCredential();
  const result = await t.mutation(api.auth.finishSignUp, {
    username,
    ...authenticator.attest(credential, start.challenge),
  });
  if (!result.success) {
    throw new Error(`The sign-up failed: ${result.userError.error}`);
  }
  return { userId: result.tokens.userId, credential };
}

/** Sign in with a passkey of an account that exists. */
async function signIn(t: T, username: string, credential: TestCredential) {
  const start = await t.mutation(api.auth.startSignIn, { username });
  if (!start.success || start.step !== "authenticate") {
    throw new Error("The username has no account.");
  }
  return await t.mutation(
    api.auth.finishSignIn,
    await authenticator.assert(credential, start.challenge),
  );
}

/** Run the whole add flow and return the passkey it stores. */
async function addPasskey(
  t: T,
  userId: string,
  authorizeWith: TestCredential,
): Promise<{ passkeyId: string; credential: TestCredential }> {
  const caller = as(t, userId);
  const start = await caller.mutation(api.auth.startAddPasskey, {});
  if (!start.success) {
    throw new Error(`The add could not start: ${start.userError.error}`);
  }
  const verified = await caller.mutation(
    api.auth.verifyAddPasskey,
    await authenticator.assert(authorizeWith, start.challenge),
  );
  if (!verified.success) {
    throw new Error(
      `The re-authentication failed: ${verified.userError.error}`,
    );
  }
  const credential = await authenticator.createCredential();
  const finished = await caller.mutation(
    api.auth.finishAddPasskey,
    authenticator.attest(credential, verified.challenge),
  );
  if (!finished.success) {
    throw new Error(`The add failed: ${finished.userError.error}`);
  }
  return { passkeyId: finished.passkeyId, credential };
}

describe("signing up and signing in", () => {
  test("creates a user with one passkey", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");

    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users.map((user) => user._id)).toEqual([alice.userId]);

    const list = await as(t, alice.userId).query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");
    expect(list.passkeys).toHaveLength(1);
    expect(list.passkeys[0]).toEqual({
      passkeyId: expect.any(String),
      credentialId: expect.any(ArrayBuffer),
      createdAt: expect.any(Number),
    });
    expectSameBytes(
      list.passkeys[0].credentialId,
      alice.credential.credentialId,
    );
  });

  test("signs in with the passkey of the account", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");

    const result = await signIn(t, "alice", alice.credential);
    expect(result).toEqual({
      success: true,
      username: "alice",
      tokens: {
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(Number),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        // Same passkey, thus the same app user.
        userId: alice.userId,
      },
    });
  });
});

describe("passkey management", () => {
  test("lists the passkeys of the caller only", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const bob = await signUp(t, "bob");
    await addPasskey(t, alice.userId, alice.credential);

    const forAlice = await as(t, alice.userId).query(api.auth.listPasskeys, {});
    const forBob = await as(t, bob.userId).query(api.auth.listPasskeys, {});
    if (!forAlice.success || !forBob.success) {
      throw new Error("Both callers are signed in.");
    }
    expect(forAlice.passkeys).toHaveLength(2);
    expect(forBob.passkeys).toHaveLength(1);
    expectSameBytes(
      forBob.passkeys[0].credentialId,
      bob.credential.credentialId,
    );
  });

  test("refuses a signed-out caller", async () => {
    const t = await setup();
    await signUp(t, "alice");
    expect(await t.query(api.auth.listPasskeys, {})).toEqual({
      success: false,
      userError: { error: "NOT_SIGNED_IN" },
    });
  });

  test("adds a second passkey that can sign in on its own", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const second = await addPasskey(t, alice.userId, alice.credential);

    const list = await as(t, alice.userId).query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");
    expect(list.passkeys.map((passkey) => passkey.passkeyId)).toContain(
      second.passkeyId,
    );

    // The stored credential is a real passkey of the account, not a row.
    const result = await signIn(t, "alice", second.credential);
    expect(result).toMatchObject({
      success: true,
      tokens: { userId: alice.userId },
    });
  });

  test("removes a passkey after a ceremony with another one", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const second = await addPasskey(t, alice.userId, alice.credential);
    const caller = as(t, alice.userId);

    const start = await caller.mutation(api.auth.startRemovePasskey, {
      passkeyId: second.passkeyId,
    });
    if (!start.success) throw new Error("The account has two passkeys.");
    // The passkey that goes away cannot authorize its own removal, thus the
    // browser must not offer it.
    expect(start.allowCredentials).toHaveLength(1);
    expectSameBytes(
      start.allowCredentials[0].id,
      alice.credential.credentialId,
    );

    expect(
      await caller.mutation(api.auth.finishRemovePasskey, {
        passkeyId: second.passkeyId,
        ...(await authenticator.assert(alice.credential, start.challenge)),
      }),
    ).toEqual({ success: true });

    const list = await caller.query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");
    expect(list.passkeys).toHaveLength(1);
    expectSameBytes(
      list.passkeys[0].credentialId,
      alice.credential.credentialId,
    );
  });

  test("refuses to remove the only passkey of the account", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const caller = as(t, alice.userId);
    const list = await caller.query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");

    expect(
      await caller.mutation(api.auth.startRemovePasskey, {
        passkeyId: list.passkeys[0].passkeyId,
      }),
    ).toEqual({ success: false, userError: { error: "LAST_PASSKEY" } });
  });
});
