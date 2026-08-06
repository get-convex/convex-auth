import { describe, expect, test } from "vitest";
import { decodePKCS1RSAPublicKey } from "../../vendor/oslo/crypto/rsa";
import { api } from "./_generated/api";
import { toArrayBuffer } from "./helpers";
import { CHALLENGE_TTL_MS } from "./validation";
import { setup } from "../passkeyTestSetup";
import {
  ORIGIN,
  RP_ID,
  buildAttestationObject,
  buildAuthenticatorData,
  buildClientDataJSON,
  encodeCBOR,
  generateES256Credential,
  generateRS256Credential,
  register,
} from "./testAuthenticator";

/** Build valid `finishRegistration` args, with overridable pieces. */
async function registrationArgs(
  t: ReturnType<typeof setup>,
  userId: string,
  options: {
    credential?: Awaited<ReturnType<typeof generateES256Credential>>;
    name?: string;
    counter?: number;
    origin?: string;
    crossOrigin?: boolean;
    clientDataType?: "webauthn.create" | "webauthn.get";
    authDataRpId?: string;
    userPresent?: boolean;
    userVerified?: boolean;
    includeCredential?: boolean;
    challenge?: ArrayBuffer;
  } = {},
) {
  const credential = options.credential ?? (await generateES256Credential());
  const challenge =
    options.challenge ??
    (await t.mutation(api.registration.startRegistration, { userId }))
      .challenge;
  const authData = buildAuthenticatorData({
    rpId: options.authDataRpId ?? RP_ID,
    counter: options.counter ?? 0,
    userPresent: options.userPresent,
    userVerified: options.userVerified,
    credential: options.includeCredential === false ? undefined : credential,
  });
  return {
    credential,
    args: {
      expectedRpId: RP_ID,
      expectedOrigin: ORIGIN,
      verifiedUserId: userId,
      name: options.name,
      attestationObject: toArrayBuffer(buildAttestationObject(authData)),
      clientDataJSON: toArrayBuffer(
        buildClientDataJSON({
          type: options.clientDataType ?? "webauthn.create",
          challenge,
          origin: options.origin ?? ORIGIN,
          crossOrigin: options.crossOrigin,
        }),
      ),
    },
  };
}

describe("startRegistration", () => {
  test("returns a 32-byte challenge and stores an anonymous registration row", async () => {
    const t = setup();
    const { challenge } = await t.mutation(api.registration.startRegistration, {
      userId: "user1",
    });
    expect(new Uint8Array(challenge).length).toBe(32);
    const rows = await t.run((ctx) => ctx.db.query("challenges").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("registration");
    expect(new Uint8Array(rows[0].challenge)).toEqual(
      new Uint8Array(challenge),
    );
    // Registration challenges carry no identity, even when a userId is given.
    expect("userId" in rows[0]).toBe(false);
  });

  test("returns no excludeCredentials without a userId", async () => {
    const t = setup();
    await register(t, "user1");
    const { excludeCredentials } = await t.mutation(
      api.registration.startRegistration,
      {},
    );
    expect(excludeCredentials).toEqual([]);
  });

  test("returns exactly the user's credential IDs as excludeCredentials", async () => {
    const t = setup();
    const first = await register(t, "user1");
    const second = await register(t, "user1");
    await register(t, "user2");
    const { excludeCredentials } = await t.mutation(
      api.registration.startRegistration,
      { userId: "user1" },
    );
    const ids = excludeCredentials.map((buffer) =>
      Array.from(new Uint8Array(buffer)).join(","),
    );
    expect(ids).toHaveLength(2);
    expect(ids).toContain(first.credential.credentialId.join(","));
    expect(ids).toContain(second.credential.credentialId.join(","));
  });
});

describe("finishRegistration", () => {
  test("stores an ES256 passkey and consumes the challenge", async () => {
    const t = setup();
    const { credential, args } = await registrationArgs(t, "user1", {
      counter: 5,
    });
    const result = await t.mutation(api.registration.finishRegistration, args);
    expect(result.success).toBe(true);

    const passkeys = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(passkeys).toHaveLength(1);
    const row = passkeys[0];
    expect(result).toEqual({ success: true, passkeyId: row._id });
    expect(row.userId).toBe("user1");
    expect(row.algorithm).toBe("ES256");
    expect(new Uint8Array(row.credentialId)).toEqual(credential.credentialId);
    expect(row.counter).toBe(5);
    // SEC1 uncompressed P-256 point: 0x04 || x || y.
    const publicKey = new Uint8Array(row.publicKey);
    expect(publicKey.length).toBe(65);
    expect(publicKey[0]).toBe(0x04);

    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toEqual([]);
  });

  test("stores an RS256 passkey with a PKCS#1 public key", async () => {
    const t = setup();
    const credential = await generateRS256Credential();
    const { args } = await registrationArgs(t, "user1", { credential });
    const result = await t.mutation(api.registration.finishRegistration, args);
    expect(result.success).toBe(true);

    const [row] = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(row.algorithm).toBe("RS256");
    const decoded = decodePKCS1RSAPublicKey(new Uint8Array(row.publicKey));
    expect(decoded.e).toBe(65537n);
  });

  test("stores the optional name", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      name: "MacBook Touch ID",
    });
    const result = await t.mutation(api.registration.finishRegistration, args);
    expect(result.success).toBe(true);
    const [row] = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(row.name).toBe("MacBook Touch ID");
  });

  test("returns CHALLENGE_EXPIRED for an unknown challenge", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      challenge: toArrayBuffer(crypto.getRandomValues(new Uint8Array(32))),
    });
    const result = await t.mutation(api.registration.finishRegistration, args);
    expect(result).toEqual({
      success: false,
      userError: { error: "CHALLENGE_EXPIRED" },
    });
  });

  test("returns CHALLENGE_EXPIRED for an expired challenge and deletes it", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1");
    await t.run(async (ctx) => {
      const row = await ctx.db.query("challenges").unique();
      await ctx.db.patch(row!._id, {
        createdAt: row!.createdAt - CHALLENGE_TTL_MS - 1000,
      });
    });
    const result = await t.mutation(api.registration.finishRegistration, args);
    expect(result).toEqual({
      success: false,
      userError: { error: "CHALLENGE_EXPIRED" },
    });
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toEqual([]);
  });

  test("throws for an authentication client data type", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      clientDataType: "webauthn.get",
    });
    await expect(
      t.mutation(api.registration.finishRegistration, args),
    ).rejects.toThrow("Unexpected client data type.");
  });

  test("throws for an unexpected origin without consuming the challenge", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      origin: "https://evil.example.net",
    });
    await expect(
      t.mutation(api.registration.finishRegistration, args),
    ).rejects.toThrow("Unexpected WebAuthn origin.");
    // The origin check happens before the challenge is consumed.
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toHaveLength(1);
  });

  test("throws for a cross-origin ceremony", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", { crossOrigin: true });
    await expect(
      t.mutation(api.registration.finishRegistration, args),
    ).rejects.toThrow("Cross-origin WebAuthn ceremonies are not allowed.");
  });

  test("throws for a relying party ID hash mismatch", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      authDataRpId: "evil.example.net",
    });
    await expect(
      t.mutation(api.registration.finishRegistration, args),
    ).rejects.toThrow("Relying party ID hash mismatch.");
  });

  test("returns VERIFICATION_FAILED when the user is not present", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", { userPresent: false });
    const result = await t.mutation(api.registration.finishRegistration, args);
    expect(result).toEqual({
      success: false,
      userError: { error: "VERIFICATION_FAILED" },
    });
  });

  test("returns VERIFICATION_FAILED when the user is not verified", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      userVerified: false,
    });
    const result = await t.mutation(api.registration.finishRegistration, args);
    expect(result).toEqual({
      success: false,
      userError: { error: "VERIFICATION_FAILED" },
    });
  });

  test("throws when the attested credential data is missing", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      includeCredential: false,
    });
    await expect(
      t.mutation(api.registration.finishRegistration, args),
    ).rejects.toThrow("Missing attested credential data.");
  });

  test("throws for an unsupported public key algorithm", async () => {
    const t = setup();
    const credential = await generateES256Credential();
    // An EdDSA (-8) COSE key.
    credential.cosePublicKey = encodeCBOR(
      new Map<number, number | Uint8Array>([
        [1, 1], // kty: OKP
        [3, -8], // alg: EdDSA
        [-1, 6], // crv: Ed25519
        [-2, new Uint8Array(32)],
      ]),
    );
    const { args } = await registrationArgs(t, "user1", { credential });
    await expect(
      t.mutation(api.registration.finishRegistration, args),
    ).rejects.toThrow("Unsupported public key algorithm.");
  });

  test("throws for an unsupported elliptic curve", async () => {
    const t = setup();
    const credential = await generateES256Credential();
    // ES256 with a P-384 (crv 2) key.
    credential.cosePublicKey = encodeCBOR(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 2], // crv: P-384
        [-2, new Uint8Array(32)],
        [-3, new Uint8Array(32)],
      ]),
    );
    const { args } = await registrationArgs(t, "user1", { credential });
    await expect(
      t.mutation(api.registration.finishRegistration, args),
    ).rejects.toThrow("Unsupported elliptic curve (expected P-256).");
  });

  test("returns CREDENTIAL_ALREADY_REGISTERED for a duplicate credential ID", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { args } = await registrationArgs(t, "user2", { credential });
    const result = await t.mutation(api.registration.finishRegistration, args);
    expect(result).toEqual({
      success: false,
      userError: { error: "CREDENTIAL_ALREADY_REGISTERED" },
    });
    // The failed attempt still burned its challenge.
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toEqual([]);
  });
});

describe("listPasskeys", () => {
  test("returns an empty array for an unknown user", async () => {
    const t = setup();
    const result = await t.query(api.registration.listPasskeys, {
      userId: "nobody",
    });
    expect(result).toEqual([]);
  });

  test("returns only the user's passkeys with public metadata only", async () => {
    const t = setup();
    const { credential, passkeyId } = await register(t, "user1", {
      name: "MacBook",
    });
    await register(t, "user2");
    const result = await t.query(api.registration.listPasskeys, {
      userId: "user1",
    });
    expect(result).toHaveLength(1);
    expect(result[0].passkeyId).toBe(passkeyId);
    expect(result[0].name).toBe("MacBook");
    expect(new Uint8Array(result[0].credentialId)).toEqual(
      credential.credentialId,
    );
    expect(typeof result[0].createdAt).toBe("number");
    // The key material never leaves the component.
    expect(result[0]).not.toHaveProperty("publicKey");
    expect(result[0]).not.toHaveProperty("counter");
  });
});

describe("deletePasskey", () => {
  test("deletes the user's own passkey", async () => {
    const t = setup();
    const { passkeyId } = await register(t, "user1");
    const result = await t.mutation(api.registration.deletePasskey, {
      userId: "user1",
      passkeyId,
    });
    expect(result).toEqual({ success: true });
    const passkeys = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(passkeys).toEqual([]);
  });

  test("refuses to delete another user's passkey", async () => {
    const t = setup();
    const { passkeyId: user1PasskeyId } = await register(t, "user1");
    const { passkeyId: user2PasskeyId } = await register(t, "user2");
    const result = await t.mutation(api.registration.deletePasskey, {
      userId: "user2",
      passkeyId: user1PasskeyId,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSKEY_NOT_FOUND" },
    });
    const passkeys = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(passkeys).toHaveLength(2);
    expect(passkeys.map((p) => p._id)).toEqual(
      expect.arrayContaining([user1PasskeyId, user2PasskeyId]),
    );
  });

  test("returns PASSKEY_NOT_FOUND for a malformed ID", async () => {
    const t = setup();
    const result = await t.mutation(api.registration.deletePasskey, {
      userId: "user1",
      passkeyId: "not-a-real-id",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSKEY_NOT_FOUND" },
    });
  });

  test("returns PASSKEY_NOT_FOUND on a double delete", async () => {
    const t = setup();
    const { passkeyId } = await register(t, "user1");
    await t.mutation(api.registration.deletePasskey, {
      userId: "user1",
      passkeyId,
    });
    const result = await t.mutation(api.registration.deletePasskey, {
      userId: "user1",
      passkeyId,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSKEY_NOT_FOUND" },
    });
  });
});
