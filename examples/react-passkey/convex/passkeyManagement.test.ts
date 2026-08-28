/**
 * The passkey-management functions of `auth.ts`, driven the way the app
 * drives them: a signed-in user lists, adds, and removes their passkeys.
 *
 * The test runs against this example app, thus it covers the wiring that a
 * real app copies — the `setupUsernamePasskey` call, the `createUser`
 * callback, and the mount paths of `convex.config.ts`.
 */
import { convexTest, type TestConvex } from "convex-test";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerCore } from "@convex-dev/auth/providers/testing/core";
import {
  buildAssertion,
  buildAttestationObject,
  buildAuthenticatorData,
  buildClientDataJSON,
  generateES256Credential,
  registerPasskeyProvider,
  type TestCredential,
} from "@convex-dev/auth/providers/testing/passkey";
import { registerUsername } from "@convex-dev/auth/providers/testing/username";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// The relying party of `auth.ts`. The software authenticator has its own
// defaults, thus every ceremony below names these.
const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";

type T = TestConvex<typeof schema>;

type Attestation = {
  attestationObject: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** Assert that two byte buffers hold the same bytes. */
function expectSameBytes(
  a: ArrayBuffer | Uint8Array,
  b: ArrayBuffer | Uint8Array,
): void {
  expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
}

async function setup(): Promise<T> {
  // The core signs JWTs from these env vars. Mint a real RS256 key pair for
  // each test and stub the env so Vitest can reset it.
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
  registerUsername(t);
  registerPasskeyProvider(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The caller as a signed-in user, the way a real access token identifies one. */
const as = (t: T, userId: string) => t.withIdentity({ subject: userId });

/** Build the `create()` payloads of a registration ceremony. */
function attest(
  challenge: ArrayBuffer,
  credential: TestCredential,
): Attestation {
  const authenticatorData = buildAuthenticatorData({
    rpId: RP_ID,
    credential,
  });
  return {
    attestationObject: toArrayBuffer(buildAttestationObject(authenticatorData)),
    clientDataJSON: toArrayBuffer(
      buildClientDataJSON({
        type: "webauthn.create",
        challenge,
        origin: ORIGIN,
      }),
    ),
  };
}

/** Build the `get()` payloads of an authentication ceremony. */
const assertWith = (credential: TestCredential, challenge: ArrayBuffer) =>
  buildAssertion(credential, challenge, { rpId: RP_ID, origin: ORIGIN });

/** Register a new account with its first passkey. */
async function signUp(
  t: T,
  username: string,
): Promise<{ userId: string; credential: TestCredential }> {
  const start = await t.mutation(api.auth.startSignIn, { username });
  if (!start.success || start.step !== "register") {
    throw new Error("The username is not free.");
  }
  const credential = await generateES256Credential();
  const result = await t.mutation(api.auth.finishSignUp, {
    username,
    ...attest(start.challenge, credential),
  });
  if (!result.success) {
    throw new Error(`The sign-up failed: ${result.userError.error}`);
  }
  return { userId: result.tokens.userId, credential };
}

/** Run the full add flow and return the new passkey. */
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
    await assertWith(authorizeWith, start.challenge),
  );
  if (!verified.success) {
    throw new Error(
      `The re-authentication failed: ${verified.userError.error}`,
    );
  }
  const credential = await generateES256Credential();
  const finished = await caller.mutation(
    api.auth.finishAddPasskey,
    attest(verified.challenge, credential),
  );
  if (!finished.success) {
    throw new Error(`The add failed: ${finished.userError.error}`);
  }
  return { passkeyId: finished.passkeyId, credential };
}

describe("listPasskeys", () => {
  test("returns the passkeys of the caller only", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const bob = await signUp(t, "bob");
    await addPasskey(t, alice.userId, alice.credential);

    const forAlice = await as(t, alice.userId).query(api.auth.listPasskeys, {});
    const forBob = await as(t, bob.userId).query(api.auth.listPasskeys, {});
    if (!forAlice.success || !forBob.success) {
      throw new Error("The caller is signed in.");
    }
    expect(forAlice.passkeys).toHaveLength(2);
    expect(forBob.passkeys).toHaveLength(1);
    expect(forAlice.passkeys[0]).toEqual({
      passkeyId: expect.any(String),
      credentialId: expect.any(ArrayBuffer),
      createdAt: expect.any(Number),
    });
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
});

describe("adding a passkey", () => {
  test("adds a second passkey through the whole flow", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const caller = as(t, alice.userId);

    const start = await caller.mutation(api.auth.startAddPasskey, {});
    if (!start.success) throw new Error("The caller is signed in.");
    expect(start.rpId).toBe(RP_ID);
    // Each passkey of the account can authorize the add.
    expect(start.allowCredentials).toHaveLength(1);
    expectSameBytes(
      start.allowCredentials[0].id,
      alice.credential.credentialId,
    );

    const verified = await caller.mutation(
      api.auth.verifyAddPasskey,
      await assertWith(alice.credential, start.challenge),
    );
    if (!verified.success) throw new Error("The assertion is valid.");
    expect(verified.rpId).toBe(RP_ID);
    // `auth.ts` names no `rpName`, thus the relying party ID stands in for it.
    expect(verified.rpName).toBe(RP_ID);
    expect(verified.username).toBe("alice");
    // The authenticator must not make a second credential for a passkey the
    // account already holds.
    expect(verified.excludeCredentials).toHaveLength(1);
    expectSameBytes(
      verified.excludeCredentials[0].id,
      alice.credential.credentialId,
    );

    const credential = await generateES256Credential();
    const finished = await caller.mutation(
      api.auth.finishAddPasskey,
      attest(verified.challenge, credential),
    );
    expect(finished).toEqual({ success: true, passkeyId: expect.any(String) });

    const list = await caller.query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");
    expect(list.passkeys).toHaveLength(2);
  });

  test("refuses an assertion that was minted for another flow", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const caller = as(t, alice.userId);

    // A sign-in challenge carries a different purpose.
    const start = await t.mutation(api.auth.startSignIn, { username: "alice" });
    if (!start.success || start.step !== "authenticate") {
      throw new Error("The username has an account.");
    }
    // A purpose that does not match is a protocol violation: the message
    // goes to the backend logs, and the client gets `PROTOCOL_ERROR`.
    expect(
      await caller.mutation(
        api.auth.verifyAddPasskey,
        await assertWith(alice.credential, start.challenge),
      ),
    ).toEqual({ success: false, userError: { error: "PROTOCOL_ERROR" } });
  });

  test("refuses a create() ceremony that no verifyAddPasskey started", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const credential = await generateES256Credential();

    // No registration challenge exists at all.
    expect(
      await as(t, alice.userId).mutation(
        api.auth.finishAddPasskey,
        attest(new ArrayBuffer(32), credential),
      ),
    ).toEqual({ success: false, userError: { error: "CHALLENGE_EXPIRED" } });
  });

  test("refuses a registration challenge that the sign-up flow minted", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");

    // The sign-up branch mints a challenge with no user, thus its handle
    // cannot link to an account that already has one.
    const start = await t.mutation(api.auth.startSignIn, { username: "carol" });
    if (!start.success || start.step !== "register") {
      throw new Error("The username is free.");
    }
    const credential = await generateES256Credential();
    await expect(
      as(t, alice.userId).mutation(
        api.auth.finishAddPasskey,
        attest(start.challenge, credential),
      ),
    ).rejects.toThrow("The user already has a different handle");
  });

  test("refuses a signed-out caller", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const notSignedIn = {
      success: false,
      userError: { error: "NOT_SIGNED_IN" },
    };

    expect(await t.mutation(api.auth.startAddPasskey, {})).toEqual(notSignedIn);
    expect(
      await t.mutation(
        api.auth.verifyAddPasskey,
        await assertWith(alice.credential, new ArrayBuffer(32)),
      ),
    ).toEqual(notSignedIn);
    expect(
      await t.mutation(
        api.auth.finishAddPasskey,
        attest(new ArrayBuffer(32), await generateES256Credential()),
      ),
    ).toEqual(notSignedIn);
  });
});

describe("removing a passkey", () => {
  test("removes a passkey through the whole flow", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const second = await addPasskey(t, alice.userId, alice.credential);
    const caller = as(t, alice.userId);

    const start = await caller.mutation(api.auth.startRemovePasskey, {
      passkeyId: second.passkeyId,
    });
    if (!start.success) throw new Error("The account has two passkeys.");
    expect(start.rpId).toBe(RP_ID);
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
        ...(await assertWith(alice.credential, start.challenge)),
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
    const list = await as(t, alice.userId).query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");

    expect(
      await as(t, alice.userId).mutation(api.auth.startRemovePasskey, {
        passkeyId: list.passkeys[0].passkeyId,
      }),
    ).toEqual({ success: false, userError: { error: "LAST_PASSKEY" } });
  });

  test("refuses an assertion from the passkey that goes away", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const second = await addPasskey(t, alice.userId, alice.credential);
    const caller = as(t, alice.userId);

    const start = await caller.mutation(api.auth.startRemovePasskey, {
      passkeyId: second.passkeyId,
    });
    if (!start.success) throw new Error("The account has two passkeys.");

    // The start step keeps the target out of `allowCredentials`, thus a
    // client that respects the protocol never sends this assertion. The
    // finish step is what enforces the rule.
    expect(
      await caller.mutation(api.auth.finishRemovePasskey, {
        passkeyId: second.passkeyId,
        ...(await assertWith(second.credential, start.challenge)),
      }),
    ).toEqual({ success: false, userError: { error: "PROTOCOL_ERROR" } });

    const list = await caller.query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");
    expect(list.passkeys.map((passkey) => passkey.passkeyId)).toContain(
      second.passkeyId,
    );
  });

  test("refuses a `passkeyId` that the start step did not get", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const second = await addPasskey(t, alice.userId, alice.credential);
    const caller = as(t, alice.userId);

    // The app starts the removal of the second passkey, thus the user
    // answers the dialog with the first one.
    const start = await caller.mutation(api.auth.startRemovePasskey, {
      passkeyId: second.passkeyId,
    });
    if (!start.success) throw new Error("The account has two passkeys.");
    const assertion = await assertWith(alice.credential, start.challenge);

    const list = await caller.query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");
    const first = list.passkeys.find(
      (passkey) => passkey.passkeyId !== second.passkeyId,
    );
    if (first === undefined) throw new Error("The account has two passkeys.");

    // The app then sends a different `passkeyId` than the one that made the
    // challenge, and that `passkeyId` is the passkey that signed. No correct
    // caller does this, thus the result is a `PROTOCOL_ERROR`.
    expect(
      await caller.mutation(api.auth.finishRemovePasskey, {
        passkeyId: first.passkeyId,
        ...assertion,
      }),
    ).toEqual({ success: false, userError: { error: "PROTOCOL_ERROR" } });

    const after = await caller.query(api.auth.listPasskeys, {});
    if (!after.success) throw new Error("The caller is signed in.");
    expect(after.passkeys).toHaveLength(2);
  });

  test("refuses a passkey of another account", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    await addPasskey(t, alice.userId, alice.credential);
    const bob = await signUp(t, "bob");
    const bobList = await as(t, bob.userId).query(api.auth.listPasskeys, {});
    if (!bobList.success) throw new Error("The caller is signed in.");

    expect(
      await as(t, alice.userId).mutation(api.auth.startRemovePasskey, {
        passkeyId: bobList.passkeys[0].passkeyId,
      }),
    ).toEqual({ success: false, userError: { error: "PASSKEY_NOT_FOUND" } });
  });

  test("refuses a passkey of another account at the finish step", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const second = await addPasskey(t, alice.userId, alice.credential);
    const bob = await signUp(t, "bob");
    const bobList = await as(t, bob.userId).query(api.auth.listPasskeys, {});
    if (!bobList.success) throw new Error("The caller is signed in.");
    const caller = as(t, alice.userId);

    // A valid challenge of the caller carries no target, thus the finish
    // step must check the ownership itself.
    const start = await caller.mutation(api.auth.startRemovePasskey, {
      passkeyId: second.passkeyId,
    });
    if (!start.success) throw new Error("The account has two passkeys.");
    expect(
      await caller.mutation(api.auth.finishRemovePasskey, {
        passkeyId: bobList.passkeys[0].passkeyId,
        ...(await assertWith(alice.credential, start.challenge)),
      }),
    ).toEqual({ success: false, userError: { error: "PASSKEY_NOT_FOUND" } });

    const stillThere = await as(t, bob.userId).query(api.auth.listPasskeys, {});
    if (!stillThere.success) throw new Error("The caller is signed in.");
    expect(stillThere.passkeys).toHaveLength(1);
  });

  test("refuses a signed-out caller", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const second = await addPasskey(t, alice.userId, alice.credential);
    const notSignedIn = {
      success: false,
      userError: { error: "NOT_SIGNED_IN" },
    };

    expect(
      await t.mutation(api.auth.startRemovePasskey, {
        passkeyId: second.passkeyId,
      }),
    ).toEqual(notSignedIn);
    expect(
      await t.mutation(api.auth.finishRemovePasskey, {
        passkeyId: second.passkeyId,
        ...(await assertWith(alice.credential, new ArrayBuffer(32))),
      }),
    ).toEqual(notSignedIn);
  });
});
