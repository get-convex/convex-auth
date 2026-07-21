/**
 * nOAuth regression: the default OIDC id_token profile extractor must surface
 * the `email_verified` claim as `emailVerified`, and MUST NOT fabricate a
 * positive signal when the claim is absent or false.
 *
 * This guards the root cause of the nOAuth account-takeover class. Before this
 * fix `server/oauth/runtime.ts` never read `email_verified`, so every OIDC
 * identity arrived with `emailVerified: undefined`, which `server/user/
 * account.ts` then defaulted to "verified" and used to link the OAuth identity
 * into any pre-existing account owning that email. Account linking now requires
 * `emailVerified === true` (see `defaultCreateOrUpdateUser`), so an extractor
 * that faithfully reports the tri-state signal is what makes an absent/false
 * claim fail to link while a genuine `email_verified: true` still links.
 */

import { expect, test } from "vite-plus/test";

import {
  createOAuthAuthorizationURL,
  handleOAuthCallback,
} from "../packages/auth/src/server/oauth/runtime";

/**
 * Build an (unsigned) id_token whose payload carries `claims`. `decodeIdToken`
 * only base64url-decodes the payload segment, so the header/signature are inert.
 */
function encodeUnsignedIdToken(claims: Record<string, unknown>): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "none", typ: "JWT" })}.${segment(claims)}.signature`;
}

/**
 * Drive the OAuth callback with a non-PKCE runtime client that returns an
 * id_token carrying `claims`, and return the extracted profile. Mirrors the
 * `handleOAuthCallback` harness in `tests/security.test.ts`.
 */
async function extractOAuthProfile(claims: Record<string, unknown>) {
  const provider = {
    pkce: "never" as const,
    createAuthorizationURL(_args: {
      state: string;
      codeVerifier?: string;
      scopes: string[];
      nonce?: string;
    }) {
      return new URL("https://idp.example.com/oauth2/authorize");
    },
    async validateAuthorizationCode(_args: { code: string }) {
      return { idToken: encodeUnsignedIdToken(claims) };
    },
  };

  const authResult = await createOAuthAuthorizationURL("oidc-test", { provider });
  const stateCookie = authResult.cookies.find((cookie) => cookie.name.endsWith("OAuthstate"));
  if (!stateCookie) {
    throw new Error("Expected the authorization step to set an OAuth state cookie.");
  }

  const result = await handleOAuthCallback(
    "oidc-test",
    { provider },
    { state: stateCookie.value, code: "authorization-code" },
    { [stateCookie.name]: stateCookie.value },
  );
  return result.profile;
}

test("id_token extractor marks emailVerified true for a boolean email_verified claim", async () => {
  const profile = await extractOAuthProfile({
    sub: "idp-user-1",
    email: "victim@example.com",
    email_verified: true,
  });

  expect(profile.id).toBe("idp-user-1");
  expect(profile.email).toBe("victim@example.com");
  expect(profile.emailVerified).toBe(true);
});

test("id_token extractor accepts a string email_verified of true as verified", async () => {
  const profile = await extractOAuthProfile({
    sub: "idp-user-2",
    email: "victim@example.com",
    email_verified: "true",
  });

  expect(profile.emailVerified).toBe(true);
});

test("id_token extractor surfaces a false email_verified without fabricating verification", async () => {
  const profile = await extractOAuthProfile({
    sub: "idp-user-3",
    email: "victim@example.com",
    email_verified: false,
  });

  // Must not be the literal `true` that email-based account linking requires.
  expect(profile.emailVerified).toBe(false);
  expect(profile.emailVerified).not.toBe(true);
});

test("id_token extractor leaves emailVerified undefined when the claim is absent (nOAuth guard)", async () => {
  const profile = await extractOAuthProfile({
    sub: "idp-user-4",
    email: "victim@example.com",
  });

  // The crux of nOAuth: an absent claim must never read as verified, so a
  // provider that omits `email_verified` cannot link into a pre-existing
  // account that owns this email (account.ts links only on `=== true`).
  expect(profile.emailVerified).toBeUndefined();
  expect(profile.emailVerified).not.toBe(true);
});
