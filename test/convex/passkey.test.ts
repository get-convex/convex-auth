import {
  isoBase64URL,
  isoCBOR,
  isoUint8Array,
  toHash,
} from "@simplewebauthn/server/helpers";
import { convexTest } from "convex-test";
import { decodeJwt } from "jose";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { CONVEX_SITE_URL, JWKS, JWT_PRIVATE_KEY } from "./test.helpers";

const ORIGIN = "http://localhost:5173";
const RP_ID = "localhost";

test("register and sign in with a passkey", async () => {
  setupEnv();
  const t = convexTest(schema);
  const authenticator = await createSoftAuthenticator();

  // Sign up by registering a passkey.
  const registration = await register(t, authenticator, {
    email: "passkey@gmail.com",
  });
  expect(registration.tokens).not.toBeNull();

  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toMatchObject([{ email: "passkey@gmail.com" }]);
    const accounts = await ctx.db.query("authAccounts").collect();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].provider).toBe("passkey");
    // The challenge was consumed.
    const challenges = await ctx.db.query("authPasskeyChallenges").collect();
    expect(challenges).toHaveLength(0);
  });

  // Sign in with the same passkey.
  const authentication = await authenticate(t, authenticator);
  expect(authentication.tokens).not.toBeNull();

  const registeredUser = decodeJwt(registration.tokens!.token).sub!.split("|")[0];
  const authenticatedUser = decodeJwt(authentication.tokens!.token).sub!.split(
    "|",
  )[0];
  expect(authenticatedUser).toEqual(registeredUser);

  // The signature counter was advanced.
  await t.run(async (ctx) => {
    const account = (await ctx.db.query("authAccounts").collect())[0];
    const stored = JSON.parse(account.secret!);
    expect(stored.counter).toBeGreaterThan(0);
  });
});

test("rejects an unknown passkey", async () => {
  setupEnv();
  const t = convexTest(schema);
  const authenticator = await createSoftAuthenticator();
  await expect(authenticate(t, authenticator)).rejects.toThrow("Unknown passkey");
});

test("rejects a tampered challenge", async () => {
  setupEnv();
  const t = convexTest(schema);
  const authenticator = await createSoftAuthenticator();
  const { data: options } = await t.action(api.auth.signIn, {
    provider: "passkey",
    params: { flow: "registrationOptions", email: "tamper@gmail.com" },
  });
  // Use a challenge the server never issued.
  const response = await buildRegistrationResponse(
    authenticator,
    isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32))),
  );
  options; // (unused, we deliberately ignore the issued challenge)
  await expect(
    t.action(api.auth.signIn, {
      provider: "passkey",
      params: { flow: "registration", response: JSON.stringify(response) },
    }),
  ).rejects.toThrow("Invalid or expired passkey challenge");
});

test("adds a passkey to a signed-in user", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { tokens } = await t.action(api.auth.signIn, { provider: "anonymous" });
  const claims = decodeJwt(tokens!.token);
  const asUser = t.withIdentity({ subject: claims.sub });

  const authenticator = await createSoftAuthenticator();
  const registration = await register(asUser, authenticator, {});
  expect(registration.tokens).not.toBeNull();

  await t.run(async (ctx) => {
    // Still a single user, now with two linked accounts.
    const users = await ctx.db.query("users").collect();
    expect(users).toHaveLength(1);
    const accounts = await ctx.db.query("authAccounts").collect();
    expect(accounts.map((a) => a.provider).sort()).toEqual([
      "anonymous",
      "passkey",
    ]);
    expect(new Set(accounts.map((a) => a.userId)).size).toBe(1);
  });
});

// --- Soft authenticator -----------------------------------------------------
//
// A minimal in-memory WebAuthn authenticator built on Web Crypto, used to
// exercise the full registration and authentication ceremonies end to end.

type SoftAuthenticator = {
  keyPair: CryptoKeyPair;
  x: Uint8Array;
  y: Uint8Array;
  credentialId: Uint8Array;
};

async function createSoftAuthenticator(): Promise<SoftAuthenticator> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return {
    keyPair,
    x: isoBase64URL.toBuffer(jwk.x!),
    y: isoBase64URL.toBuffer(jwk.y!),
    credentialId: crypto.getRandomValues(new Uint8Array(16)),
  };
}

async function register(
  t: ReturnType<typeof convexTest> | ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  authenticator: SoftAuthenticator,
  params: Record<string, string>,
) {
  const { data: options } = await t.action(api.auth.signIn, {
    provider: "passkey",
    params: { flow: "registrationOptions", ...params },
  });
  const response = await buildRegistrationResponse(
    authenticator,
    (options as any).challenge,
  );
  return await t.action(api.auth.signIn, {
    provider: "passkey",
    params: { flow: "registration", response: JSON.stringify(response), ...params },
  });
}

async function authenticate(
  t: ReturnType<typeof convexTest>,
  authenticator: SoftAuthenticator,
) {
  const { data: options } = await t.action(api.auth.signIn, {
    provider: "passkey",
    params: { flow: "authenticationOptions" },
  });
  const authData = await makeAuthData(0x05, 1);
  const clientDataJSON = makeClientDataJSON(
    "webauthn.get",
    (options as any).challenge,
  );
  const signed = isoUint8Array.concat([authData, await toHash(clientDataJSON)]);
  // WebCrypto emits a fixed 64-byte (r || s) signature. We DER-encode it for
  // the response, but @simplewebauthn's `unwrapEC2Signature` strips the DER
  // sign byte without re-padding to 32 bytes — so if r or s has a leading zero
  // byte the unwrapped signature ends up < 64 bytes and verification fails.
  // Re-sign (ECDSA uses a fresh random nonce each time) until neither r nor s
  // has a leading zero, which keeps the round-trip exactly 32 + 32 bytes.
  let rawSignature: Uint8Array;
  do {
    rawSignature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        authenticator.keyPair.privateKey,
        signed,
      ),
    );
  } while (rawSignature[0] === 0 || rawSignature[32] === 0);
  const response = {
    id: isoBase64URL.fromBuffer(authenticator.credentialId),
    rawId: isoBase64URL.fromBuffer(authenticator.credentialId),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      authenticatorData: isoBase64URL.fromBuffer(authData),
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      signature: isoBase64URL.fromBuffer(rawToDer(rawSignature)),
    },
  };
  return await t.action(api.auth.signIn, {
    provider: "passkey",
    params: { flow: "authentication", response: JSON.stringify(response) },
  });
}

async function buildRegistrationResponse(
  authenticator: SoftAuthenticator,
  challenge: string,
) {
  const cosePublicKey = encodeCoseKey(authenticator.x, authenticator.y);
  const attestedCredentialData = isoUint8Array.concat([
    new Uint8Array(16), // AAGUID
    uint16(authenticator.credentialId.length),
    authenticator.credentialId,
    cosePublicKey,
  ]);
  // flags: UP (0x01) | UV (0x04) | AT (0x40)
  const authData = await makeAuthData(0x45, 0, attestedCredentialData);
  const attestationObject = isoCBOR.encode(
    new Map<string, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]) as any,
  );
  const clientDataJSON = makeClientDataJSON("webauthn.create", challenge);
  return {
    id: isoBase64URL.fromBuffer(authenticator.credentialId),
    rawId: isoBase64URL.fromBuffer(authenticator.credentialId),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
      transports: ["internal"],
    },
  };
}

function encodeCoseKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  // COSE keys: 1=kty, 3=alg, -1=crv, -2=x, -3=y
  const key = new Map<number, number | Uint8Array>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, x],
    [-3, y],
  ]);
  return isoCBOR.encode(key as any);
}

async function makeAuthData(
  flags: number,
  signCount: number,
  attestedCredentialData?: Uint8Array,
): Promise<Uint8Array> {
  const rpIdHash = await toHash(isoUint8Array.fromASCIIString(RP_ID));
  const counter = new Uint8Array(4);
  new DataView(counter.buffer).setUint32(0, signCount, false);
  const parts = [rpIdHash, new Uint8Array([flags]), counter];
  if (attestedCredentialData !== undefined) {
    parts.push(attestedCredentialData);
  }
  return isoUint8Array.concat(parts);
}

function makeClientDataJSON(type: string, challenge: string): Uint8Array {
  return isoUint8Array.fromUTF8String(
    JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }),
  );
}

function uint16(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value, false);
  return buf;
}

// Convert a Web Crypto raw ECDSA signature (r || s) into the ASN.1 DER
// structure WebAuthn authenticators emit.
function rawToDer(raw: Uint8Array): Uint8Array {
  const r = derInteger(raw.slice(0, 32));
  const s = derInteger(raw.slice(32, 64));
  const sequence = isoUint8Array.concat([r, s]);
  return isoUint8Array.concat([new Uint8Array([0x30, sequence.length]), sequence]);
}

function derInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start++;
  }
  let value = bytes.slice(start);
  if ((value[0] & 0x80) !== 0) {
    value = isoUint8Array.concat([new Uint8Array([0]), value]);
  }
  return isoUint8Array.concat([new Uint8Array([0x02, value.length]), value]);
}

function setupEnv() {
  process.env.SITE_URL = ORIGIN;
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
