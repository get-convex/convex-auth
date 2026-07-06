/**
 * TOTP (authenticator-app 2FA) tests.
 *
 * Focus: the enrollment round-trip works with the secret encrypted at rest
 * (audit finding "TOTP secrets stored plaintext"). `setup` seals the secret
 * with the server AES-GCM box before storing it in `TotpFactor.secret`, and
 * `verify` decrypts it server-side — the stored bytes are never the raw secret,
 * and the raw secret is no longer smuggled through the challenge verifier.
 */

import { api, components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { decodeJwt } from "jose";
import { expect, test } from "vite-plus/test";

import { convexTest } from "./convex/setup";
import { expectSignInSession, TEST_EMAIL, TEST_PASSWORD } from "./helpers";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode an unpadded RFC 4648 base32 string (case-insensitive) to bytes. */
function decodeBase32(input: string): Uint8Array {
  const chars = input.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of chars) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Generate an RFC 6238 TOTP code (HMAC-SHA1) for the given base32 secret. */
async function generateTotpCode(base32Secret: string, period: number, digits: number) {
  const key = decodeBase32(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / period);
  const counterBytes = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const hmac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      counterBytes.buffer.slice(
        counterBytes.byteOffset,
        counterBytes.byteOffset + counterBytes.byteLength,
      ) as ArrayBuffer,
    ),
  );
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

/** Sign up a fresh user via password and return an identity-bound test client. */
async function signedInUser(t: ReturnType<typeof convexTest>, email = TEST_EMAIL) {
  const tokens = expectSignInSession(
    await t.action(api.auth.signIn, {
      provider: "password",
      params: { email, password: TEST_PASSWORD, flow: "signUp" },
    }),
  );
  const claims = decodeJwt(tokens!.token);
  return t.withIdentity({ subject: claims.sub, sid: claims.sid as never });
}

test("totp setup stores the secret encrypted, not in plaintext", async () => {
  const t = convexTest(schema);
  const asUser = await signedInUser(t, "totp-enc@example.com");

  const setup = await asUser.action(api.auth.signIn, {
    provider: "totp",
    params: { flow: "setup" },
  });
  expect(setup.kind).toBe("totpSetup");
  if (setup.kind !== "totpSetup") throw new Error("expected totpSetup");
  const { secret, totpId } = setup.totpSetup;

  const stored = await t.run((ctx) =>
    ctx.runQuery(components.auth.factor.totp.get, { id: totpId }),
  );
  expect(stored).not.toBeNull();
  // The stored bytes must NOT equal the raw base32 secret shown to the user.
  const storedText = new TextDecoder().decode(stored!.secret as ArrayBuffer);
  expect(storedText).not.toContain(secret);
  // AES-GCM box format is `iv.ciphertext` (base64url) — a dot-separated pair.
  expect(storedText.split(".")).toHaveLength(2);

  // The challenge verifier must NOT carry the raw secret any more — the stored
  // signature is JSON with purpose/userId/totpId but no `secret` field.
  const verifierDoc = await t.run((ctx) =>
    ctx.runQuery(components.auth.token.pkce.get, { id: setup.verifier }),
  );
  expect(verifierDoc).not.toBeNull();
  expect(verifierDoc!.signature).toBeDefined();
  expect(JSON.parse(verifierDoc!.signature as string)).not.toHaveProperty("secret");
});

test("totp enrollment verifies against the encrypted secret", async () => {
  const t = convexTest(schema);
  const asUser = await signedInUser(t, "totp-verify@example.com");

  const setup = await asUser.action(api.auth.signIn, {
    provider: "totp",
    params: { flow: "setup" },
  });
  if (setup.kind !== "totpSetup") throw new Error("expected totpSetup");
  const { secret, totpId } = setup.totpSetup;
  const verifier = setup.verifier;

  const code = await generateTotpCode(secret, 30, 6);

  const verified = await asUser.action(api.auth.signIn, {
    provider: "totp",
    params: { flow: "verify", code, totpId },
    verifier,
  });
  expect(verified.kind).toBe("signedIn");

  const stored = await t.run((ctx) =>
    ctx.runQuery(components.auth.factor.totp.get, { id: totpId }),
  );
  expect(stored?._id).toBe(totpId);
  expect(stored?.verified).toBe(true);

  // The user's verified enrollment resolves — the encrypted secret decrypted
  // correctly during the enrollment check.
  const resolved = await t.run((ctx) =>
    ctx.runQuery(components.auth.factor.totp.get, { verifiedForUserId: stored!.userId }),
  );
  expect(resolved?._id).toBe(totpId);
});

test("totp enrollment rejects an invalid code", async () => {
  const t = convexTest(schema);
  const asUser = await signedInUser(t, "totp-bad@example.com");

  const setup = await asUser.action(api.auth.signIn, {
    provider: "totp",
    params: { flow: "setup" },
  });
  if (setup.kind !== "totpSetup") throw new Error("expected totpSetup");
  const { totpId } = setup.totpSetup;

  await expect(
    asUser.action(api.auth.signIn, {
      provider: "totp",
      params: { flow: "verify", code: "000000", totpId },
      verifier: setup.verifier,
    }),
  ).rejects.toThrow();
});
