import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import { CHALLENGE_TTL_MS } from "./validation.ts";
import { expectSameBytes, setup } from "../passkeyTestSetup.ts";
import {
  ORIGIN,
  RP_ID,
  buildAssertion,
  generateES256Credential,
  generateRS256Credential,
  register,
} from "./testAuthenticator.ts";

const EXPECTED = { expectedRpId: RP_ID, expectedOrigin: ORIGIN };

// Only the expiry test moves the clock, but the restore is global to keep the
// other tests on the real clock.
afterEach(() => {
  vi.useRealTimers();
});

describe("startAuthentication", () => {
  test("stores a user-bound challenge and returns the user's credential IDs", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    await register(t, "user2");
    const { challenge, allowCredentials } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    expect(new Uint8Array(challenge).length).toBe(32);
    expect(allowCredentials).toHaveLength(1);
    expectSameBytes(allowCredentials[0].id, credential.credentialId);
    const [row] = await t.run((ctx) => ctx.db.query("challenges").collect());
    expect(row.kind).toBe("authentication");
    expect(row.kind === "authentication" && row.userId).toBe("user1");
  });

  test("returns the transports of each passkey in allowCredentials", async () => {
    const t = setup();
    const stored = await register(t, "user1", { transports: ["hybrid"] });
    const withoutTransports = await register(t, "user1");
    const { allowCredentials } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );

    const byId = new Map(
      allowCredentials.map((entry) => [
        Array.from(new Uint8Array(entry.id)).join(","),
        entry,
      ]),
    );
    expect(
      byId.get(stored.credential.credentialId.join(","))?.transports,
    ).toEqual(["hybrid"]);
    const absent = byId.get(
      withoutTransports.credential.credentialId.join(","),
    );
    expect(absent).toBeDefined();
    expect(absent).not.toHaveProperty("transports");
  });

  test("stores an unbound challenge with no allowCredentials for the discoverable flow", async () => {
    const t = setup();
    await register(t, "user1");
    const { allowCredentials } = await t.mutation(
      api.authentication.startAuthentication,
      {},
    );
    expect(allowCredentials).toEqual([]);
    const [row] = await t.run((ctx) => ctx.db.query("challenges").collect());
    expect(row.kind === "authentication" && row.userId).toBe(undefined);
  });
});

describe("finishAuthentication", () => {
  test("authenticates with an ES256 passkey and consumes the challenge", async () => {
    const t = setup();
    const { credential, passkeyId } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge, {
      counter: 7,
    });
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(result).toEqual({ success: true, userId: "user1", passkeyId });

    const [row] = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(row.counter).toBe(7);
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toEqual([]);
  });

  test("authenticates with an RS256 passkey", async () => {
    const t = setup();
    const credential = await generateRS256Credential();
    const { passkeyId } = await register(t, "user1", { credential });
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(result).toEqual({ success: true, userId: "user1", passkeyId });
  });

  test("identifies the user in the discoverable flow", async () => {
    const t = setup();
    const { credential, passkeyId } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      {},
    );
    const assertion = await buildAssertion(credential, challenge);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(result).toEqual({ success: true, userId: "user1", passkeyId });
  });

  test("returns UNKNOWN_CREDENTIAL without consuming the challenge", async () => {
    const t = setup();
    await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    const unregistered = await generateES256Credential();
    const assertion = await buildAssertion(unregistered, challenge);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "UNKNOWN_CREDENTIAL" },
    });
    // The challenge survives an attempt with an unknown credential.
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toHaveLength(1);
  });

  test("throws for authenticator data that is too short", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    await expect(
      t.mutation(api.authentication.finishAuthentication, {
        ...EXPECTED,
        ...assertion,
        authenticatorData: new Uint8Array(10).buffer,
      }),
    ).rejects.toThrow("Failed to parse authenticator data");
  });

  test("throws for a relying party ID hash mismatch", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge, {
      rpId: "evil.example.net",
    });
    await expect(
      t.mutation(api.authentication.finishAuthentication, {
        ...EXPECTED,
        ...assertion,
      }),
    ).rejects.toThrow("Relying party ID hash mismatch.");
  });

  test("returns VERIFICATION_FAILED when the user is not present or not verified", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    // The flag checks run before the challenge is consumed, so the same
    // challenge can serve both variants.
    for (const flags of [{ userPresent: false }, { userVerified: false }]) {
      const assertion = await buildAssertion(credential, challenge, flags);
      const result = await t.mutation(api.authentication.finishAuthentication, {
        ...EXPECTED,
        ...assertion,
      });
      expect(result).toEqual({
        success: false,
        userError: { error: "VERIFICATION_FAILED" },
      });
    }
  });

  test("throws for a registration client data type", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge, {
      type: "webauthn.create",
    });
    await expect(
      t.mutation(api.authentication.finishAuthentication, {
        ...EXPECTED,
        ...assertion,
      }),
    ).rejects.toThrow("Unexpected client data type.");
  });

  test("throws for an unexpected origin", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge, {
      origin: "https://evil.example.net",
    });
    await expect(
      t.mutation(api.authentication.finishAuthentication, {
        ...EXPECTED,
        ...assertion,
      }),
    ).rejects.toThrow("Unexpected WebAuthn origin.");
  });

  test("throws for a cross-origin ceremony", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge, {
      crossOrigin: true,
    });
    await expect(
      t.mutation(api.authentication.finishAuthentication, {
        ...EXPECTED,
        ...assertion,
      }),
    ).rejects.toThrow("Cross-origin WebAuthn ceremonies are not allowed.");
  });

  test("returns CHALLENGE_EXPIRED for an expired challenge", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    // The age of a challenge is the age of its `_creationTime`, thus the
    // clock is the only way to make the challenge expire.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + CHALLENGE_TTL_MS + 1000);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "CHALLENGE_EXPIRED" },
    });
  });

  test("returns VERIFICATION_FAILED when the challenge is bound to another user", async () => {
    const t = setup();
    await register(t, "userA");
    const { credential: credentialB } = await register(t, "userB");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "userA" },
    );
    const assertion = await buildAssertion(credentialB, challenge);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "VERIFICATION_FAILED" },
    });
    // The mismatch happens after consumption: the challenge is burned.
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toEqual([]);
  });

  test("returns VERIFICATION_FAILED for an ES256 signature by the wrong key", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    const otherKey = await generateES256Credential();
    const assertion = await buildAssertion(credential, challenge, {
      signWith: otherKey,
    });
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "VERIFICATION_FAILED" },
    });
  });

  test("returns VERIFICATION_FAILED for invalid RS256 signature bytes", async () => {
    const t = setup();
    const credential = await generateRS256Credential();
    await register(t, "user1", { credential });
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
      signature: crypto.getRandomValues(new Uint8Array(256)).buffer,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "VERIFICATION_FAILED" },
    });
  });

  test("throws for ES256 signature bytes that are not DER", async () => {
    // Pins the current behavior: a signature that does not even decode as
    // DER throws (aborting the transaction) instead of returning
    // VERIFICATION_FAILED.
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    await expect(
      t.mutation(api.authentication.finishAuthentication, {
        ...EXPECTED,
        ...assertion,
        signature: new Uint8Array(10).buffer,
      }),
    ).rejects.toThrow("Failed to decode signature");
  });

  test("rejects a replayed assertion with CHALLENGE_EXPIRED", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    const first = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(first.success).toBe(true);
    const second = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(second).toEqual({
      success: false,
      userError: { error: "CHALLENGE_EXPIRED" },
    });
  });
});
