import { afterEach, describe, expect, test, vi } from "vitest";
import { decodePKCS1RSAPublicKey } from "../../vendor/oslo/crypto/rsa.ts";
import { api } from "./_generated/api.ts";
import { toArrayBuffer } from "./helpers.ts";
import { CHALLENGE_TTL_MS } from "./validation.ts";
import {
  ORIGIN,
  RP_ID,
  buildAttestationObject,
  buildAuthenticatorData,
  buildClientDataJSON,
  encodeCBOR,
  generateES256Credential,
  generateRS256Credential,
} from "@convex-dev/passkey-test-authenticator";
import {
  expectProtocolError,
  expectSameBytes,
  register,
  setup,
} from "../passkeyTestSetup.ts";

function handleRows(t: ReturnType<typeof setup>) {
  return t.run((ctx) => ctx.db.query("handles").collect());
}

/**
 * Make the one challenge in flight expire. The age of a challenge is the age
 * of its `_creationTime`, thus the clock is the only way to make it expire.
 */
function expireChallenge() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + CHALLENGE_TTL_MS + 1000);
}

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
    // Run the new-account flow, where no user exists yet and only
    // `finishRegistration` knows the verified user.
    isNewAccountFlow?: boolean;
    // The user that `startRegistration` receives. It is `userId` by default.
    // `null` starts the new-account flow, which makes an unlinked handle.
    startUserId?: string | null;
  } = {},
) {
  const credential = options.credential ?? (await generateES256Credential());
  const startUserId = options.isNewAccountFlow
    ? null
    : options.startUserId !== undefined
      ? options.startUserId
      : userId;
  let challenge: ArrayBuffer;
  let userHandle: ArrayBuffer | null;
  if (options.challenge !== undefined) {
    // A supplied challenge stands in for a ceremony that the component does
    // not know, thus no ceremony starts in that case.
    challenge = options.challenge;
    userHandle = null;
  } else {
    const started = await t.mutation(api.registration.startRegistration, {
      userId: startUserId,
    });
    challenge = started.challenge;
    userHandle = started.userHandle;
  }
  const authData = await buildAuthenticatorData({
    rpId: options.authDataRpId ?? RP_ID,
    counter: options.counter ?? 0,
    userPresent: options.userPresent,
    userVerified: options.userVerified,
    credential: options.includeCredential === false ? undefined : credential,
  });
  return {
    credential,
    userHandle,
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

// Only the expiry tests move the clock, but the restore is global to keep the
// other tests on the real clock.
afterEach(() => {
  vi.useRealTimers();
});

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
    expectSameBytes(rows[0].challenge, challenge);
    // Registration challenges carry no identity, even when a userId is given:
    // they point at a handle instead.
    expect("userId" in rows[0]).toBe(false);
    const handles = await handleRows(t);
    expect(rows[0]).toMatchObject({ handleId: handles[0]._id });
  });

  test("makes an unlinked handle in the new-account flow", async () => {
    const t = setup();
    const { userHandle, excludeCredentials } = await t.mutation(
      api.registration.startRegistration,
      { userId: null },
    );
    // 64 bytes is the WebAuthn maximum length for `user.id`.
    expect(new Uint8Array(userHandle).length).toBe(64);
    expect(excludeCredentials).toEqual([]);

    const handles = await handleRows(t);
    expect(handles).toHaveLength(1);
    expect(handles[0].userId).toBe(null);
    expectSameBytes(handles[0].handle, userHandle);
  });

  test("makes a linked handle for a known user with no handle", async () => {
    const t = setup();
    const { userHandle } = await t.mutation(
      api.registration.startRegistration,
      { userId: "user1" },
    );
    const handles = await handleRows(t);
    expect(handles).toHaveLength(1);
    expect(handles[0].userId).toBe("user1");
    expectSameBytes(handles[0].handle, userHandle);
  });

  test("reuses the existing handle of a user", async () => {
    const t = setup();
    const first = await t.mutation(api.registration.startRegistration, {
      userId: "user1",
    });
    const second = await t.mutation(api.registration.startRegistration, {
      userId: "user1",
    });

    expectSameBytes(second.userHandle, first.userHandle);
    // Each user has a maximum of one handle.
    expect(await handleRows(t)).toHaveLength(1);
    // The challenges are distinct, and both point at the same handle.
    expect(new Uint8Array(second.challenge)).not.toEqual(
      new Uint8Array(first.challenge),
    );
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    const handleIds = new Set(
      challenges.map((row) =>
        row.kind === "registration" ? row.handleId : null,
      ),
    );
    expect(handleIds.size).toBe(1);
  });

  test("makes a separate handle for each user", async () => {
    const t = setup();
    const first = await t.mutation(api.registration.startRegistration, {
      userId: "user1",
    });
    const second = await t.mutation(api.registration.startRegistration, {
      userId: "user2",
    });

    expect(new Uint8Array(second.userHandle)).not.toEqual(
      new Uint8Array(first.userHandle),
    );
    expect(await handleRows(t)).toHaveLength(2);
  });

  test("does not reuse the unlinked handle of another ceremony", async () => {
    const t = setup();
    const first = await t.mutation(api.registration.startRegistration, {
      userId: null,
    });
    const second = await t.mutation(api.registration.startRegistration, {
      userId: null,
    });

    expect(new Uint8Array(second.userHandle)).not.toEqual(
      new Uint8Array(first.userHandle),
    );
    expect(await handleRows(t)).toHaveLength(2);
  });

  test("returns no excludeCredentials without a userId", async () => {
    const t = setup();
    await register(t, "user1");
    const { excludeCredentials } = await t.mutation(
      api.registration.startRegistration,
      { userId: null },
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
    const ids = excludeCredentials.map(({ id }) =>
      Array.from(new Uint8Array(id)).join(","),
    );
    expect(ids).toHaveLength(2);
    expect(ids).toContain(first.credential.credentialId.join(","));
    expect(ids).toContain(second.credential.credentialId.join(","));
  });

  test("returns the transports of each passkey in excludeCredentials", async () => {
    const t = setup();
    const stored = await register(t, "user1", { transports: ["usb", "nfc"] });
    const withoutTransports = await register(t, "user1");
    const { excludeCredentials } = await t.mutation(
      api.registration.startRegistration,
      { userId: "user1" },
    );

    const byId = new Map(
      excludeCredentials.map((entry) => [
        Array.from(new Uint8Array(entry.id)).join(","),
        entry,
      ]),
    );
    expect(
      byId.get(stored.credential.credentialId.join(","))?.transports,
    ).toEqual(["usb", "nfc"]);
    const absent = byId.get(
      withoutTransports.credential.credentialId.join(","),
    );
    expect(absent).toBeDefined();
    expect(absent).not.toHaveProperty("transports");
  });

  test("throws when a new handle collides with an existing handle", async () => {
    const t = setup();
    // Make each new handle the same bytes. Only the 64-byte values are
    // handles: the challenges (32 bytes) stay random.
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    const spy = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementation((array) =>
        array !== null && array.byteLength === 64
          ? (array as Uint8Array<ArrayBuffer>).fill(7)
          : getRandomValues(array as Uint8Array<ArrayBuffer>),
      );
    try {
      await t.mutation(api.registration.startRegistration, { userId: "user1" });
      await expect(
        t.mutation(api.registration.startRegistration, { userId: "user2" }),
      ).rejects.toThrow("collides with an existing handle");
    } finally {
      spy.mockRestore();
    }
    const handles = await t.run((ctx) => ctx.db.query("handles").collect());
    expect(handles).toHaveLength(1);
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
    expectSameBytes(row.credentialId, credential.credentialId);
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

  test("stores the transports that the client reports", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1");
    const result = await t.mutation(api.registration.finishRegistration, {
      ...args,
      transports: ["internal", "hybrid"],
    });
    expect(result.success).toBe(true);
    const [row] = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(row.transports).toEqual(["internal", "hybrid"]);
  });

  test("stores no transports when the client reports none", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1");
    const result = await t.mutation(api.registration.finishRegistration, args);
    expect(result.success).toBe(true);
    const [row] = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(row).not.toHaveProperty("transports");
  });

  test.each([
    {
      name: "too many transports",
      transports: Array.from({ length: 17 }, (_, i) => `t${i}`),
    },
    { name: "a transport that is too long", transports: ["a".repeat(33)] },
    { name: "an empty transport", transports: [""] },
    { name: "a transport with a non-ASCII character", transports: ["üsb"] },
    { name: "a transport with a space", transports: ["smart card"] },
  ])("returns PROTOCOL_ERROR for $name", async ({ transports }) => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1");
    // One message covers every rule, thus the values are what the logs
    // carry about this rejection.
    await expectProtocolError(
      () =>
        t.mutation(api.registration.finishRegistration, {
          ...args,
          transports,
        }),
      `The client sent: ${JSON.stringify(transports)}.`,
    );
    expect(await t.run((ctx) => ctx.db.query("passkeys").collect())).toEqual(
      [],
    );
  });

  test("links the handle to the verified user in the new-account flow", async () => {
    const t = setup();
    const { userHandle, args } = await registrationArgs(t, "user1", {
      isNewAccountFlow: true,
    });
    const result = await t.mutation(api.registration.finishRegistration, args);
    expect(result.success).toBe(true);

    const handles = await handleRows(t);
    expect(handles).toHaveLength(1);
    expect(handles[0].userId).toBe("user1");
    expectSameBytes(handles[0].handle, userHandle!);
  });

  test("keeps the handle of a user that adds a second passkey", async () => {
    const t = setup();
    const first = await registrationArgs(t, "user1", {
      isNewAccountFlow: true,
    });
    await t.mutation(api.registration.finishRegistration, first.args);
    const second = await registrationArgs(t, "user1");
    const result = await t.mutation(
      api.registration.finishRegistration,
      second.args,
    );

    expect(result.success).toBe(true);
    expectSameBytes(second.userHandle!, first.userHandle!);
    expect(await handleRows(t)).toHaveLength(1);
  });

  test("throws for a handle that belongs to a different user", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user2", {
      startUserId: "user1",
    });
    await expect(
      t.mutation(api.registration.finishRegistration, args),
    ).rejects.toThrow("The handle belongs to a different user.");
  });

  test("throws for an unlinked handle when the user already has one", async () => {
    const t = setup();
    // A ceremony that starts as a new account, but that finishes with a user
    // that already has a handle. The invariant is that this cannot happen.
    const { args } = await registrationArgs(t, "user1", {
      isNewAccountFlow: true,
    });
    await t.run((ctx) =>
      ctx.db.insert("handles", {
        handle: new Uint8Array(64).fill(9).buffer,
        userId: "user1",
      }),
    );
    await expect(
      t.mutation(api.registration.finishRegistration, args),
    ).rejects.toThrow("The user already has a different handle.");
  });

  test("throws when the handle of the challenge no longer exists", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      isNewAccountFlow: true,
    });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("handles").collect()) {
        await ctx.db.delete("handles", row._id);
      }
    });
    await expect(
      t.mutation(api.registration.finishRegistration, args),
    ).rejects.toThrow("The handle of the challenge does not exist.");
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
    expireChallenge();
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

  test("erases the unlinked handle of an expired challenge", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      isNewAccountFlow: true,
    });
    expireChallenge();
    await t.mutation(api.registration.finishRegistration, args);
    // The ceremony can never complete, thus its handle goes away too.
    expect(await handleRows(t)).toEqual([]);
  });

  test("keeps the linked handle of an expired challenge", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1");
    expireChallenge();
    await t.mutation(api.registration.finishRegistration, args);
    // The handle belongs to the user, thus it survives the dead ceremony.
    expect(await handleRows(t)).toHaveLength(1);
  });

  test("returns PROTOCOL_ERROR for an authentication client data type", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      clientDataType: "webauthn.get",
    });
    await expectProtocolError(
      () => t.mutation(api.registration.finishRegistration, args),
      'a registration ceremony must send "webauthn.create"',
    );
  });

  test("returns PROTOCOL_ERROR for an unexpected origin without consuming the challenge", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      origin: "https://evil.example.net",
    });
    await expectProtocolError(
      () => t.mutation(api.registration.finishRegistration, args),
      'the ceremony ran at the origin "https://evil.example.net"',
    );
    // The origin check happens before the challenge is consumed.
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toHaveLength(1);
  });

  test("returns PROTOCOL_ERROR for a cross-origin ceremony", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", { crossOrigin: true });
    await expectProtocolError(
      () => t.mutation(api.registration.finishRegistration, args),
      "the ceremony ran in a cross-origin frame",
    );
  });

  test("returns PROTOCOL_ERROR for a relying party ID hash mismatch", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      authDataRpId: "evil.example.net",
    });
    await expectProtocolError(
      () => t.mutation(api.registration.finishRegistration, args),
      `does not match the expected relying party ID "${RP_ID}"`,
    );
  });

  test("returns PROTOCOL_ERROR when the user is not present", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", { userPresent: false });
    await expectProtocolError(
      () => t.mutation(api.registration.finishRegistration, args),
      "no user presence or no user verification",
    );
  });

  test("returns PROTOCOL_ERROR when the user is not verified", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      userVerified: false,
    });
    await expectProtocolError(
      () => t.mutation(api.registration.finishRegistration, args),
      "no user presence or no user verification",
    );
  });

  test("erases the unlinked handle when the user is not verified", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      startUserId: null,
      userVerified: false,
    });
    const result = await t.mutation(api.registration.finishRegistration, args);
    expect(result.success).toBe(false);
    // The failed attempt burned the challenge. The ceremony can never
    // complete, thus its unlinked handle goes away too.
    expect(await handleRows(t)).toEqual([]);
  });

  test("keeps the linked handle when the user is not verified", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      userVerified: false,
    });
    const result = await t.mutation(api.registration.finishRegistration, args);
    expect(result.success).toBe(false);
    // The handle belongs to the user, thus it survives the failed attempt.
    expect((await handleRows(t)).map((row) => row.userId)).toEqual(["user1"]);
  });

  test("returns PROTOCOL_ERROR when the attested credential data is missing", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      includeCredential: false,
    });
    await expectProtocolError(
      () => t.mutation(api.registration.finishRegistration, args),
      "carries no attested credential data",
    );
  });

  test("returns PROTOCOL_ERROR for an unsupported public key algorithm", async () => {
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
    await expectProtocolError(
      () => t.mutation(api.registration.finishRegistration, args),
      "the credential uses the COSE key algorithm -8",
    );
  });

  test("returns PROTOCOL_ERROR for an unsupported elliptic curve", async () => {
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
    await expectProtocolError(
      () => t.mutation(api.registration.finishRegistration, args),
      "the credential uses the elliptic curve 2",
    );
  });

  test("returns PROTOCOL_ERROR for a duplicate credential ID", async () => {
    const t = setup();
    await register(t, "user1");
    const { credential } = await register(t, "user1");
    // A second ceremony for a new account, with a credential that exists.
    // A compliant client cannot cause this.
    const { args } = await registrationArgs(t, "user2", {
      isNewAccountFlow: true,
      credential,
    });
    await expectProtocolError(
      () => t.mutation(api.registration.finishRegistration, args),
      "the credential is already registered",
    );
    // The attempt burns the challenge, and the unlinked handle of the new
    // account goes away with it.
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toEqual([]);
    expect((await handleRows(t)).map((row) => row.userId)).toEqual(["user1"]);
  });

  test("deletes the unlinked handle when verification fails in the new-account flow", async () => {
    const t = setup();
    const { challenge } = await t.mutation(api.registration.startRegistration, {
      userId: null,
    });
    const { args } = await registrationArgs(t, "user1", {
      challenge,
      userVerified: false,
    });
    const result = await t.mutation(api.registration.finishRegistration, args);
    expect(result).toEqual({
      success: false,
      userError: { error: "PROTOCOL_ERROR" },
    });
    // The failure burned the challenge, so the cleanup loop cannot find the
    // handle later. The mutation must delete the handle itself.
    const handles = await t.run((ctx) => ctx.db.query("handles").collect());
    expect(handles).toEqual([]);
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toEqual([]);
  });

  test("keeps the linked handle when verification fails for an existing user", async () => {
    const t = setup();
    await register(t, "user1");
    const { args } = await registrationArgs(t, "user1", {
      userVerified: false,
    });
    const result = await t.mutation(api.registration.finishRegistration, args);
    expect(result).toEqual({
      success: false,
      userError: { error: "PROTOCOL_ERROR" },
    });
    // The handle belongs to user1, so the failed attempt must not remove it.
    const handles = await t.run((ctx) => ctx.db.query("handles").collect());
    expect(handles).toHaveLength(1);
    expect(handles[0].userId).toBe("user1");
  });
});

describe("checkRegistration", () => {
  /** `checkRegistration` takes the finish arguments without the user fields. */
  function checkArgs({
    expectedRpId,
    expectedOrigin,
    attestationObject,
    clientDataJSON,
  }: Awaited<ReturnType<typeof registrationArgs>>["args"]) {
    return { expectedRpId, expectedOrigin, attestationObject, clientDataJSON };
  }

  test("returns success for a valid attestation and writes nothing", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1");
    const result = await t.query(
      api.registration.checkRegistration,
      checkArgs(args),
    );
    expect(result).toEqual({ success: true });
    // A query cannot write: the challenge stays for the finish call.
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("passkeys").collect())).toEqual(
      [],
    );
  });

  test("returns CHALLENGE_EXPIRED for an expired challenge", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1");
    expireChallenge();
    const result = await t.query(
      api.registration.checkRegistration,
      checkArgs(args),
    );
    expect(result).toEqual({
      success: false,
      userError: { error: "CHALLENGE_EXPIRED" },
    });
  });

  test("returns PROTOCOL_ERROR when the user is not verified", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      userVerified: false,
    });
    await expectProtocolError(
      () => t.query(api.registration.checkRegistration, checkArgs(args)),
      "no user presence or no user verification",
    );
  });

  test("returns PROTOCOL_ERROR for a duplicate credential ID", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { args } = await registrationArgs(t, "user2", { credential });
    await expectProtocolError(
      () => t.query(api.registration.checkRegistration, checkArgs(args)),
      "the credential is already registered",
    );
  });

  test("returns PROTOCOL_ERROR for an unexpected origin, like the finish call", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      origin: "https://evil.example.net",
    });
    await expectProtocolError(
      () => t.query(api.registration.checkRegistration, checkArgs(args)),
      'the ceremony ran at the origin "https://evil.example.net"',
    );
  });

  test("returns PROTOCOL_ERROR for transports that the client made up", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1");
    await expectProtocolError(
      () =>
        t.query(api.registration.checkRegistration, {
          ...checkArgs(args),
          transports: ["smart card"],
        }),
      'The client sent: ["smart card"].',
    );
  });

  test("a finish with the same arguments succeeds after a successful check", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", { startUserId: null });
    const check = await t.query(
      api.registration.checkRegistration,
      checkArgs(args),
    );
    expect(check).toEqual({ success: true });
    const finish = await t.mutation(api.registration.finishRegistration, args);
    expect(finish.success).toBe(true);
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
    expectSameBytes(result[0].credentialId, credential.credentialId);
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

  test("keeps the handle so a later passkey reuses it", async () => {
    const t = setup();
    const { passkeyId } = await register(t, "user1");
    const [handle] = await handleRows(t);
    await t.mutation(api.registration.deletePasskey, {
      userId: "user1",
      passkeyId,
    });

    // The user keeps their handle, thus a new passkey reuses it.
    const handles = await handleRows(t);
    expect(handles).toHaveLength(1);
    expect(handles[0].userId).toBe("user1");
    const next = await t.mutation(api.registration.startRegistration, {
      userId: "user1",
    });
    expectSameBytes(next.userHandle, handle.handle);
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

describe("deleteUser", () => {
  test("erases the passkeys, the handle, and the challenges of the user", async () => {
    const t = setup();
    await register(t, "user1");
    await register(t, "user1");
    const authenticationChallengeId = await t.run((ctx) =>
      ctx.db.insert("challenges", {
        kind: "authentication",
        purpose: "test",
        challenge: new Uint8Array(32).fill(0xaa).buffer,
        userId: "user1",
      }),
    );

    await t.mutation(api.registration.deleteUser, { userId: "user1" });

    expect(await t.run((ctx) => ctx.db.query("passkeys").collect())).toEqual(
      [],
    );
    expect(await handleRows(t)).toEqual([]);
    expect(
      await t.run((ctx) => ctx.db.get("challenges", authenticationChallengeId)),
    ).toBe(null);
  });

  test("keeps an in-flight registration challenge until the TTL", async () => {
    const t = setup();
    await register(t, "user1");
    // An in-flight ceremony that adds a passkey to the user.
    await t.mutation(api.registration.startRegistration, { userId: "user1" });

    await t.mutation(api.registration.deleteUser, { userId: "user1" });

    // A registration challenge has no `userId`, thus it survives. That is
    // safe: its handle is gone, so a finish attempt throws, and the cleanup
    // loop erases the challenge after the TTL.
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toHaveLength(1);
    expect(challenges[0].kind).toBe("registration");
  });

  test("keeps the rows of the other users", async () => {
    const t = setup();
    await register(t, "user1");
    await register(t, "user2");
    const otherChallengeId = await t.run((ctx) =>
      ctx.db.insert("challenges", {
        kind: "authentication",
        purpose: "test",
        challenge: new Uint8Array(32).fill(0xbb).buffer,
        userId: "user2",
      }),
    );
    // A discoverable-credential challenge has no user: it survives too.
    const anonymousChallengeId = await t.run((ctx) =>
      ctx.db.insert("challenges", {
        kind: "authentication",
        purpose: "test",
        challenge: new Uint8Array(32).fill(0xcc).buffer,
      }),
    );

    await t.mutation(api.registration.deleteUser, { userId: "user1" });

    const passkeys = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(passkeys.map((row) => row.userId)).toEqual(["user2"]);
    const handles = await handleRows(t);
    expect(handles.map((row) => row.userId)).toEqual(["user2"]);
    expect(
      await t.run((ctx) => ctx.db.get("challenges", otherChallengeId)),
    ).not.toBe(null);
    expect(
      await t.run((ctx) => ctx.db.get("challenges", anonymousChallengeId)),
    ).not.toBe(null);
  });

  test("gives a new handle to a user that registers again", async () => {
    const t = setup();
    await register(t, "user1");
    const [first] = await handleRows(t);
    await t.mutation(api.registration.deleteUser, { userId: "user1" });

    const second = await t.mutation(api.registration.startRegistration, {
      userId: "user1",
    });
    expect(new Uint8Array(second.userHandle)).not.toEqual(
      new Uint8Array(first.handle),
    );
  });

  test("does nothing for a user with no passkey data", async () => {
    const t = setup();
    await register(t, "user1");

    await t.mutation(api.registration.deleteUser, { userId: "user2" });

    expect(
      await t.run((ctx) => ctx.db.query("passkeys").collect()),
    ).toHaveLength(1);
    expect(await handleRows(t)).toHaveLength(1);
  });
});
