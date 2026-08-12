import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { api } from "./_generated/api.js";
import { registerCore } from "@convex-dev/auth/providers/testing/core";
import { registerPasskeyProvider } from "@convex-dev/auth/providers/testing/passkey";
import { registerUsername } from "@convex-dev/auth/providers/testing/username";
import {
  buildAssertion,
  buildAttestationObject,
  buildAuthenticatorData,
  buildClientDataJSON,
  generateES256Credential,
  type TestCredential,
} from "@convex-dev/auth/providers/passkey/testAuthenticator";
import { toArrayBuffer } from "@convex-dev/auth/providers/passkey/helpers";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

// These values must agree with the provider options in `auth.ts`.
const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";

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
  registerPasskeyProvider(t);
  registerUsername(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

type T = Awaited<ReturnType<typeof setup>>;

const EXPECTED_TOKENS = {
  accessToken: expect.any(String),
  accessTokenExpiresAt: expect.any(Number),
  refreshToken: expect.any(String),
  refreshTokenExpiresAt: expect.any(Number),
  userId: expect.any(String),
};

/** Send a crafted registration ceremony result to `finishSignUp`. */
async function finishSignUp(
  t: T,
  username: string,
  credential: TestCredential,
  challenge: ArrayBuffer,
  name?: string,
) {
  const authData = buildAuthenticatorData({ rpId: RP_ID, credential });
  return await t.mutation(api.auth.finishSignUp, {
    username,
    name,
    attestationObject: toArrayBuffer(buildAttestationObject(authData)),
    clientDataJSON: toArrayBuffer(
      buildClientDataJSON({
        type: "webauthn.create",
        challenge,
        origin: ORIGIN,
      }),
    ),
  });
}

/** Run the full sign-up flow with a fresh credential. */
async function signUp(t: T, username: string, name?: string) {
  const start = await t.mutation(api.auth.startSignIn, { username });
  if (start.step !== "register") {
    throw new Error(`Expected the register step, got ${start.step}`);
  }
  const credential = await generateES256Credential();
  const result = await finishSignUp(
    t,
    username,
    credential,
    start.challenge,
    name,
  );
  if (!result.success) {
    throw new Error(`Test sign-up failed: ${result.userError.error}`);
  }
  return { credential, result, userHandle: start.userHandle };
}

/** Run the full sign-in flow with an existing credential. */
async function signIn(t: T, username: string, credential: TestCredential) {
  const start = await t.mutation(api.auth.startSignIn, { username });
  if (start.step !== "authenticate") {
    throw new Error(`Expected the authenticate step, got ${start.step}`);
  }
  const assertion = await buildAssertion(credential, start.challenge, {
    rpId: RP_ID,
    origin: ORIGIN,
  });
  return await t.mutation(api.auth.finishSignIn, assertion);
}

/** A test accessor with the identity of a signed-in user. */
function asUser(t: T, userId: string) {
  return t.withIdentity({ subject: userId });
}

describe("sign-up", () => {
  test("creates the account, reuses the provisional row, and returns a session", async () => {
    const t = await setup();
    const { result, userHandle } = await signUp(t, "alice");
    expect(result).toEqual({
      success: true,
      tokens: EXPECTED_TOKENS,
      username: "alice",
    });
    // The session belongs to the row that `startSignIn` created: the
    // WebAuthn user handle. No second user row exists.
    expect(result.success && result.tokens.userId).toBe(userHandle);
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0].username).toBe("alice");
  });

  test("an abandoned registration leaks an empty user row (accepted by design)", async () => {
    const t = await setup();
    const start = await t.mutation(api.auth.startSignIn, { username: "bob" });
    expect(start.step).toBe("register");
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0].username).toBe(undefined);
  });

  test("USERNAME_TAKEN keeps the challenge valid, and another username completes", async () => {
    const t = await setup();
    // Carol starts a registration...
    const start = await t.mutation(api.auth.startSignIn, {
      username: "carol",
    });
    if (start.step !== "register") throw new Error("Expected register");
    const credential = await generateES256Credential();
    // ...but someone else snatches the username while the ceremony runs.
    await signUp(t, "carol");

    const taken = await finishSignUp(t, "carol", credential, start.challenge);
    expect(taken).toEqual({
      success: false,
      userError: { error: "USERNAME_TAKEN" },
    });
    // The same ceremony result completes with a different username: the
    // failed attempt did not burn the challenge.
    const retry = await finishSignUp(t, "carol-2", credential, start.challenge);
    expect(retry).toEqual({
      success: true,
      tokens: EXPECTED_TOKENS,
      username: "carol-2",
    });
  });

  test("usernames are case-insensitive", async () => {
    const t = await setup();
    await signUp(t, "Alice");
    const start = await t.mutation(api.auth.startSignIn, {
      username: "ALICE",
    });
    expect(start.step).toBe("authenticate");
  });

  test("rejects a malformed username, and the challenge stays valid", async () => {
    const t = await setup();
    const start = await t.mutation(api.auth.startSignIn, { username: "dave" });
    if (start.step !== "register") throw new Error("Expected register");
    const credential = await generateES256Credential();

    const invalid = await finishSignUp(t, " dave", credential, start.challenge);
    expect(invalid).toEqual({
      success: false,
      userError: { error: "USERNAME_HAS_SURROUNDING_WHITESPACE" },
    });

    // The format check runs before the ceremony result is examined, so the
    // client can send the same ceremony result again.
    const retry = await finishSignUp(t, "dave", credential, start.challenge);
    expect(retry).toEqual({
      success: true,
      tokens: EXPECTED_TOKENS,
      username: "dave",
    });
  });
});

describe("sign-in", () => {
  test("signs in with a registered passkey and returns the stored username", async () => {
    const t = await setup();
    const { credential, result: up } = await signUp(t, "Alice");
    const result = await signIn(t, "alice", credential);
    expect(result).toEqual({
      success: true,
      tokens: EXPECTED_TOKENS,
      // The username component stores the username as the user supplied
      // it; sign-in reports that spelling.
      username: "Alice",
    });
    // Same account → same app user id.
    expect(result.success && result.tokens.userId).toBe(
      up.success && up.tokens.userId,
    );
  });

  test("rejects an unknown credential", async () => {
    const t = await setup();
    await signUp(t, "alice");
    const stranger = await generateES256Credential();
    const result = await signIn(t, "alice", stranger);
    expect(result).toEqual({
      success: false,
      userError: { error: "UNKNOWN_CREDENTIAL" },
    });
  });

  test("rejects an assertion signed with the wrong key", async () => {
    const t = await setup();
    const { credential } = await signUp(t, "alice");
    const otherKey = await generateES256Credential();
    const start = await t.mutation(api.auth.startSignIn, {
      username: "alice",
    });
    if (start.step !== "authenticate") throw new Error("Expected authenticate");
    const assertion = await buildAssertion(credential, start.challenge, {
      rpId: RP_ID,
      origin: ORIGIN,
      signWith: otherKey,
    });
    const result = await t.mutation(api.auth.finishSignIn, assertion);
    expect(result).toEqual({
      success: false,
      userError: { error: "VERIFICATION_FAILED" },
    });
  });

  test("rejects another user's passkey on a challenge bound to this user", async () => {
    const t = await setup();
    await signUp(t, "alice");
    const { credential: bobCredential } = await signUp(t, "bob");
    const result = await signIn(t, "alice", bobCredential);
    expect(result).toEqual({
      success: false,
      userError: { error: "VERIFICATION_FAILED" },
    });
  });
});

describe("changeUsername", () => {
  test("renames the account and frees the old username", async () => {
    const t = await setup();
    const { credential, result: up } = await signUp(t, "alice");
    const userId = up.success ? up.tokens.userId : "";
    const result = await asUser(t, userId).mutation(api.auth.changeUsername, {
      newUsername: "wonderland",
    });
    expect(result).toEqual({ success: true, username: "wonderland" });

    // The app's user record follows the rename.
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0].username).toBe("wonderland");

    // The passkey signs in under the new username, with the same user id.
    const signedIn = await signIn(t, "wonderland", credential);
    expect(signedIn.success && signedIn.tokens.userId).toBe(userId);

    // The old username is free again.
    const start = await t.mutation(api.auth.startSignIn, {
      username: "alice",
    });
    expect(start.step).toBe("register");
  });

  test("rejects a taken username, case-insensitively", async () => {
    const t = await setup();
    await signUp(t, "alice");
    const { result: up } = await signUp(t, "bob");
    const userId = up.success ? up.tokens.userId : "";
    const result = await asUser(t, userId).mutation(api.auth.changeUsername, {
      newUsername: "ALICE",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "USERNAME_TAKEN" },
    });
  });

  test("accepts a casing-only change of the own username", async () => {
    const t = await setup();
    const { result: up } = await signUp(t, "carol");
    const userId = up.success ? up.tokens.userId : "";
    const result = await asUser(t, userId).mutation(api.auth.changeUsername, {
      newUsername: "Carol",
    });
    expect(result).toEqual({ success: true, username: "Carol" });
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users[0].username).toBe("Carol");
  });

  test("rejects a malformed new username with a format error", async () => {
    const t = await setup();
    const { result: up } = await signUp(t, "alice");
    const userId = up.success ? up.tokens.userId : "";
    const result = await asUser(t, userId).mutation(api.auth.changeUsername, {
      newUsername: " alice ",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "USERNAME_HAS_SURROUNDING_WHITESPACE" },
    });
  });

  test("requires a signed-in user", async () => {
    const t = await setup();
    await expect(
      t.mutation(api.auth.changeUsername, { newUsername: "nobody" }),
    ).rejects.toThrow("This function requires a signed-in user.");
  });
});

describe("addPasskey", () => {
  test("adds a second passkey that can sign in", async () => {
    const t = await setup();
    const { credential: first, result: up } = await signUp(t, "alice");
    const userId = up.success ? up.tokens.userId : "";
    const user = asUser(t, userId);

    const start = await user.mutation(api.auth.startAddPasskey, {});
    expect(start.userHandle).toBe(userId);
    // The authenticator gets the existing credential, so it refuses a
    // duplicate registration.
    expect(
      start.excludeCredentials.map((buffer) =>
        Array.from(new Uint8Array(buffer)).join(","),
      ),
    ).toContain(first.credentialId.join(","));

    const second = await generateES256Credential();
    const authData = buildAuthenticatorData({
      rpId: RP_ID,
      credential: second,
    });
    const result = await user.mutation(api.auth.finishAddPasskey, {
      name: "Backup key",
      attestationObject: toArrayBuffer(buildAttestationObject(authData)),
      clientDataJSON: toArrayBuffer(
        buildClientDataJSON({
          type: "webauthn.create",
          challenge: start.challenge,
          origin: ORIGIN,
        }),
      ),
    });
    expect(result).toEqual({ success: true, passkeyId: expect.any(String) });

    const passkeys = await user.query(api.auth.listPasskeys, {});
    expect(passkeys).toHaveLength(2);

    const signedIn = await signIn(t, "alice", second);
    expect(signedIn.success && signedIn.tokens.userId).toBe(userId);
  });

  test("rejects a registration challenge of a different user", async () => {
    const t = await setup();
    const { result: aliceUp } = await signUp(t, "alice");
    const aliceId = aliceUp.success ? aliceUp.tokens.userId : "";
    const { result: bobUp } = await signUp(t, "bob");
    const bobId = bobUp.success ? bobUp.tokens.userId : "";

    // Alice starts an add-passkey ceremony, and Bob sends its result.
    const start = await asUser(t, aliceId).mutation(
      api.auth.startAddPasskey,
      {},
    );
    const credential = await generateES256Credential();
    const authData = buildAuthenticatorData({ rpId: RP_ID, credential });
    await expect(
      asUser(t, bobId).mutation(api.auth.finishAddPasskey, {
        attestationObject: toArrayBuffer(buildAttestationObject(authData)),
        clientDataJSON: toArrayBuffer(
          buildClientDataJSON({
            type: "webauthn.create",
            challenge: start.challenge,
            origin: ORIGIN,
          }),
        ),
      }),
    ).rejects.toThrow(
      "The registration challenge belongs to a different user.",
    );
    // The rejected mutation rolled back: Bob has only his own passkey.
    const passkeys = await asUser(t, bobId).query(api.auth.listPasskeys, {});
    expect(passkeys).toHaveLength(1);
  });

  test("requires a signed-in user", async () => {
    const t = await setup();
    await expect(t.mutation(api.auth.startAddPasskey, {})).rejects.toThrow(
      "This function requires a signed-in user.",
    );
  });
});

describe("listPasskeys", () => {
  test("returns only the signed-in user's passkeys", async () => {
    const t = await setup();
    const { result: aliceUp } = await signUp(t, "alice", "Alice's key");
    const aliceId = aliceUp.success ? aliceUp.tokens.userId : "";
    await signUp(t, "bob");

    const passkeys = await asUser(t, aliceId).query(api.auth.listPasskeys, {});
    expect(passkeys).toHaveLength(1);
    expect(passkeys[0].name).toBe("Alice's key");
  });

  test("requires a signed-in user", async () => {
    const t = await setup();
    await expect(t.query(api.auth.listPasskeys, {})).rejects.toThrow(
      "This function requires a signed-in user.",
    );
  });
});

describe("deletePasskey", () => {
  /** Sign up and add a second passkey. Returns both credentials and ids. */
  async function setupTwoPasskeys(t: T) {
    const { credential: first, result: up } = await signUp(t, "alice");
    const userId = up.success ? up.tokens.userId : "";
    const user = asUser(t, userId);
    const start = await user.mutation(api.auth.startAddPasskey, {});
    const second = await generateES256Credential();
    const authData = buildAuthenticatorData({
      rpId: RP_ID,
      credential: second,
    });
    const added = await user.mutation(api.auth.finishAddPasskey, {
      attestationObject: toArrayBuffer(buildAttestationObject(authData)),
      clientDataJSON: toArrayBuffer(
        buildClientDataJSON({
          type: "webauthn.create",
          challenge: start.challenge,
          origin: ORIGIN,
        }),
      ),
    });
    if (!added.success) throw new Error("Test add-passkey failed");
    const passkeys = await user.query(api.auth.listPasskeys, {});
    const byCredential = (credential: TestCredential) => {
      const match = passkeys.find(
        (passkey) =>
          Array.from(new Uint8Array(passkey.credentialId)).join(",") ===
          credential.credentialId.join(","),
      );
      if (match === undefined) throw new Error("Credential not stored");
      return match.passkeyId;
    };
    return {
      user,
      userId,
      first,
      second,
      firstId: byCredential(first),
      secondId: byCredential(second),
    };
  }

  test("deletes a passkey after an assertion from a different passkey", async () => {
    const t = await setup();
    const { user, second, firstId, secondId } = await setupTwoPasskeys(t);

    const start = await user.mutation(api.auth.startDeletePasskey, {
      passkeyId: firstId,
    });
    if (!start.success) throw new Error("Expected a delete challenge");
    // The marked passkey cannot approve its own deletion, so only the
    // other credential is allowed.
    expect(
      start.allowCredentials.map((buffer) =>
        Array.from(new Uint8Array(buffer)).join(","),
      ),
    ).toEqual([second.credentialId.join(",")]);

    const assertion = await buildAssertion(second, start.challenge, {
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const result = await user.mutation(api.auth.finishDeletePasskey, {
      passkeyId: firstId,
      ...assertion,
    });
    expect(result).toEqual({ success: true });
    const passkeys = await user.query(api.auth.listPasskeys, {});
    expect(passkeys.map((passkey) => passkey.passkeyId)).toEqual([secondId]);
  });

  test("rejects the assertion of the marked passkey (SAME_PASSKEY)", async () => {
    const t = await setup();
    const { user, first, firstId } = await setupTwoPasskeys(t);

    const start = await user.mutation(api.auth.startDeletePasskey, {
      passkeyId: firstId,
    });
    if (!start.success) throw new Error("Expected a delete challenge");
    // A tampered client ignores `allowCredentials` and signs with the
    // marked passkey itself. The server refuses.
    const assertion = await buildAssertion(first, start.challenge, {
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const result = await user.mutation(api.auth.finishDeletePasskey, {
      passkeyId: firstId,
      ...assertion,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "SAME_PASSKEY" },
    });
    const passkeys = await user.query(api.auth.listPasskeys, {});
    expect(passkeys).toHaveLength(2);
  });

  test("refuses to delete the last passkey (NO_OTHER_PASSKEY)", async () => {
    const t = await setup();
    const { result: up } = await signUp(t, "alice");
    const userId = up.success ? up.tokens.userId : "";
    const user = asUser(t, userId);
    const passkeys = await user.query(api.auth.listPasskeys, {});
    const result = await user.mutation(api.auth.startDeletePasskey, {
      passkeyId: passkeys[0].passkeyId,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "NO_OTHER_PASSKEY" },
    });
  });

  test("returns PASSKEY_NOT_FOUND for an unknown or foreign passkey id", async () => {
    const t = await setup();
    const { user } = await setupTwoPasskeys(t);
    const { result: bobUp } = await signUp(t, "bob");
    const bobId = bobUp.success ? bobUp.tokens.userId : "";
    const bobPasskeys = await asUser(t, bobId).query(api.auth.listPasskeys, {});

    for (const passkeyId of ["not-a-real-id", bobPasskeys[0].passkeyId]) {
      const result = await user.mutation(api.auth.startDeletePasskey, {
        passkeyId,
      });
      expect(result).toEqual({
        success: false,
        userError: { error: "PASSKEY_NOT_FOUND" },
      });
    }
  });
});
