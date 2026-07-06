/**
 * Passkey (WebAuthn) tests.
 *
 * Focus: the passkey verify path is rate-limited (audit finding H9), reaching
 * TOTP parity. Verification attempts against a resolvable credential consume
 * sign-in rate-limit tokens, and once the limit is exhausted the verify flow
 * fails closed with `RATE_LIMITED` — before any signature work.
 */

import { api, components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { ConvexError } from "convex/values";
import { expect, test } from "vite-plus/test";

import { convexTest } from "./convex/setup";

const RP_ORIGIN = "http://localhost:5173";
const DEFAULT_MAX_ATTEMPTS = 10;

/** base64url-encode a UTF-8 string with no padding (WebAuthn clientDataJSON). */
function base64url(input: string) {
  const b64 = Buffer.from(input, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test("passkey verify is rate-limited after the failure threshold", async () => {
  const t = convexTest(schema);

  // Seed a user + a resolvable passkey credential.
  const { userId } = await t.run(async (ctx) => {
    const userId = (await ctx.runMutation(components.auth.user.create, {
      data: { email: "passkey-rl@example.com" },
    })) as string;
    await ctx.runMutation(components.auth.factor.passkey.create, {
      userId: userId as never,
      credentialId: "rl-credential",
      publicKey: new ArrayBuffer(32),
      algorithm: -7,
      counter: 0,
      deviceType: "multiDevice",
      backedUp: true,
      createdAt: Date.now(),
    });
    return { userId };
  });

  // Exhaust the sign-in rate limit for this user (token bucket capacity 10).
  await t.run(async (ctx) => {
    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS + 2; i++) {
      await ctx.runMutation(components.auth.limits.signInRecord, {
        identifier: userId,
        maxAttemptsPerHour: DEFAULT_MAX_ATTEMPTS,
      });
    }
  });

  // Issue a real passkey challenge, then submit a verify for the seeded
  // credential. The rate-limit gate fires before any signature check.
  const options = await t.action(api.auth.signIn, {
    provider: "passkey",
    params: { flow: "signIn" },
  });
  expect(options.kind).toBe("passkeyOptions");
  if (options.kind !== "passkeyOptions") throw new Error("expected passkeyOptions");
  const challenge = (options.options as { challenge: string }).challenge;
  const clientDataJSON = base64url(
    JSON.stringify({ type: "webauthn.get", challenge, origin: RP_ORIGIN, crossOrigin: false }),
  );

  const error = await t
    .action(api.auth.signIn, {
      provider: "passkey",
      params: {
        flow: "verify",
        credentialId: "rl-credential",
        clientDataJSON,
        signature: "AA",
        authenticatorData: "AA",
      },
      verifier: options.verifier,
    })
    .then(
      () => null,
      (e) => e,
    );
  expect(error).toBeInstanceOf(ConvexError);
  expect((error as ConvexError<{ code: string }>).data.code).toBe("RATE_LIMITED");
});

test("passkey verify against an unknown credential is rejected", async () => {
  const t = convexTest(schema);

  const options = await t.action(api.auth.signIn, {
    provider: "passkey",
    params: { flow: "signIn" },
  });
  if (options.kind !== "passkeyOptions") throw new Error("expected passkeyOptions");
  const challenge = (options.options as { challenge: string }).challenge;
  const clientDataJSON = base64url(
    JSON.stringify({ type: "webauthn.get", challenge, origin: RP_ORIGIN, crossOrigin: false }),
  );

  await expect(
    t.action(api.auth.signIn, {
      provider: "passkey",
      params: {
        flow: "verify",
        credentialId: "does-not-exist",
        clientDataJSON,
        signature: "AA",
        authenticatorData: "AA",
      },
      verifier: options.verifier,
    }),
  ).rejects.toThrow(ConvexError);
});
