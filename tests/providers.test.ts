/**
 * Provider factory config tests (audit finding H16 — "Provider config" was ZERO
 * coverage).
 *
 * Every `defineAuth` provider is a pure synchronous constructor that emits a
 * plain config object; the framework never re-derives these fields, so the
 * emitted shape (id/type, default scopes, endpoints, redirectUri handling,
 * documented defaults) is the contract these factories owe their callers. These
 * tests pin that shape.
 *
 * OAuth factories that omit `redirectUri` derive one from `authUrlFromEnv()`
 * eagerly at construction (the arctic wrapper probes the provider on the first
 * call), so importing the convex setup below seeds `CONVEX_SITE_URL`. Where a
 * test does not care about the derived URL it passes an explicit `redirectUri`
 * to stay hermetic.
 */

import { apple } from "@robelest/convex-auth/providers/apple";
import { credentials } from "@robelest/convex-auth/providers/credentials";
import { custom } from "@robelest/convex-auth/providers/custom";
import { github } from "@robelest/convex-auth/providers/github";
import { google } from "@robelest/convex-auth/providers/google";
import {
  anonymous,
  connection,
  device,
  email,
  passkey,
  phone,
  totp,
} from "@robelest/convex-auth/providers/index";
import { microsoft } from "@robelest/convex-auth/providers/microsoft";
import { password } from "@robelest/convex-auth/providers/password";
import { expect, test } from "vite-plus/test";

// Importing the convex setup for its side effect: it seeds CONVEX_SITE_URL /
// APP_URL so the env-derived-redirect-URI tests below have an auth site URL.
import "./convex/setup";

const SITE_URL = process.env.CONVEX_SITE_URL ?? "http://127.0.0.1:3211";

// ---------------------------------------------------------------------------
// OAuth providers (github / google / apple / microsoft / custom)
// ---------------------------------------------------------------------------

test("github() emits an oauth config with the documented default scope", () => {
  const provider = github({
    clientId: "gh-id",
    clientSecret: "gh-secret",
    redirectUri: "https://app.example/callback/github",
  });
  expect(provider.id).toBe("github");
  expect(provider.type).toBe("oauth");
  expect(provider.scopes).toEqual(["user:email"]);
  // GitHub is not OIDC, so the wrapper supplies a profile() fetcher and never
  // uses PKCE.
  expect(typeof provider.profile).toBe("function");
  expect(provider.provider?.pkce).toBe("never");
  expect(provider.nonce).toBeUndefined();
  expect(provider.validateTokens).toBeUndefined();
});

test("github() forwards custom scopes and account-linking options", () => {
  const provider = github({
    clientId: "gh-id",
    clientSecret: "gh-secret",
    redirectUri: "https://app.example/callback/github",
    scopes: ["read:user", "user:email"],
    accountLinking: "verifiedEmail",
    updateProfileOnLogin: false,
  });
  expect(provider.scopes).toEqual(["read:user", "user:email"]);
  expect(provider.accountLinking).toBe("verifiedEmail");
  expect(provider.updateProfileOnLogin).toBe(false);
});

test("google() emits an OIDC config with openid/profile/email and required PKCE", () => {
  const provider = google({
    clientId: "g-id",
    clientSecret: "g-secret",
    redirectUri: "https://app.example/callback/google",
  });
  expect(provider.id).toBe("google");
  expect(provider.type).toBe("oauth");
  expect(provider.scopes).toEqual(["openid", "profile", "email"]);
  // Google is OIDC: no bespoke profile fetcher; PKCE is required.
  expect(provider.profile).toBeUndefined();
  expect(provider.provider?.pkce).toBe("required");
});

test("apple() emits name/email scopes and accepts a Uint8Array private key", () => {
  const provider = apple({
    clientId: "com.example.app",
    teamId: "TEAM123",
    keyId: "KEY123",
    privateKey: new TextEncoder().encode(
      "-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----",
    ),
    redirectUri: "https://app.example/callback/apple",
  });
  expect(provider.id).toBe("apple");
  expect(provider.type).toBe("oauth");
  expect(provider.scopes).toEqual(["name", "email"]);
  // Apple's client-secret JWT is minted lazily by arctic during the token
  // exchange, not at construction, so there is nothing synchronous to assert
  // beyond that the provider materialized without throwing.
  expect(provider.provider?.pkce).toBe("never");
});

test("microsoft() requires a nonce and installs an id_token validator", () => {
  const provider = microsoft({
    tenant: "common",
    clientId: "ms-id",
    clientSecret: "ms-secret",
    redirectUri: "https://app.example/callback/microsoft",
  });
  expect(provider.id).toBe("microsoft");
  expect(provider.type).toBe("oauth");
  expect(provider.scopes).toEqual(["openid", "profile", "email"]);
  expect(provider.nonce).toBe(true);
  expect(typeof provider.validateTokens).toBe("function");
  expect(provider.provider?.pkce).toBe("required");
});

test("custom() defaults scopes to [] and PKCE to required", () => {
  const provider = custom({
    id: "workos",
    clientId: "wos-id",
    clientSecret: "wos-secret",
    redirectUri: "https://app.example/callback/workos",
    authorization: { url: "https://api.workos.com/authorize" },
    token: { url: "https://api.workos.com/token" },
  });
  expect(provider.id).toBe("workos");
  expect(provider.type).toBe("oauth");
  expect(provider.scopes).toEqual([]);
  expect(provider.provider?.pkce).toBe("required");
});

test("custom() builds a PKCE authorization URL with S256 and default param names", () => {
  const provider = custom({
    id: "acme",
    clientId: "acme-id",
    redirectUri: "https://app.example/callback/acme",
    scopes: ["read", "write"],
    authorization: { url: "https://acme.example/oauth/authorize" },
    token: { url: "https://acme.example/oauth/token" },
  });
  const url = provider.provider!.createAuthorizationURL({
    state: "the-state",
    codeVerifier: "verifier-123",
    scopes: [],
  });
  expect(url.origin + url.pathname).toBe("https://acme.example/oauth/authorize");
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("client_id")).toBe("acme-id");
  expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/callback/acme");
  expect(url.searchParams.get("state")).toBe("the-state");
  // No requested scopes were passed, so the configured defaults join with a space.
  expect(url.searchParams.get("scope")).toBe("read write");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
});

test("custom() honors scopeSeparator, custom param names, and extraParams", () => {
  const provider = custom({
    id: "acme",
    clientId: "acme-id",
    redirectUri: "https://app.example/callback/acme",
    scopes: ["a", "b"],
    authorization: {
      url: "https://acme.example/authorize",
      pkce: "never",
      clientIdParam: "app_id",
      scopeParam: "scopes",
      scopeSeparator: ",",
      extraParams: { audience: "https://api.acme.example" },
    },
    token: { url: "https://acme.example/token" },
  });
  const url = provider.provider!.createAuthorizationURL({
    state: "s",
    scopes: [],
  });
  expect(url.searchParams.get("app_id")).toBe("acme-id");
  expect(url.searchParams.get("scopes")).toBe("a,b");
  expect(url.searchParams.get("audience")).toBe("https://api.acme.example");
  // PKCE "never" must not emit a challenge.
  expect(url.searchParams.get("code_challenge")).toBeNull();
});

test("custom() authorization URL prefers runtime-requested scopes over defaults", () => {
  const provider = custom({
    id: "acme",
    clientId: "acme-id",
    redirectUri: "https://app.example/callback/acme",
    scopes: ["default-only"],
    authorization: { url: "https://acme.example/authorize", pkce: "never" },
    token: { url: "https://acme.example/token" },
  });
  const url = provider.provider!.createAuthorizationURL({
    state: "s",
    scopes: ["runtime-scope"],
  });
  expect(url.searchParams.get("scope")).toBe("runtime-scope");
});

test('custom() token exchange with authMethod:"basic" and no secret throws deterministically', async () => {
  const provider = custom({
    id: "acme",
    clientId: "acme-id",
    // no clientSecret
    redirectUri: "https://app.example/callback/acme",
    authorization: { url: "https://acme.example/authorize", pkce: "never" },
    token: { url: "https://acme.example/token", authMethod: "basic" },
  });
  await expect(provider.provider!.validateAuthorizationCode({ code: "abc" })).rejects.toThrow(
    'requires clientSecret for token.authMethod="basic"',
  );
});

test("OAuth providers derive redirectUri from CONVEX_SITE_URL when omitted", () => {
  // Construction alone must succeed without an explicit redirectUri; the arctic
  // wrapper probes the provider eagerly, which reads the env-derived auth URL.
  // We assert the derived callback path is reflected in the built auth URL.
  const provider = custom({
    id: "envcheck",
    clientId: "id",
    authorization: { url: "https://idp.example/authorize", pkce: "never" },
    token: { url: "https://idp.example/token" },
  });
  const url = provider.provider!.createAuthorizationURL({ state: "s", scopes: [] });
  expect(url.searchParams.get("redirect_uri")).toBe(`${SITE_URL}/auth/callback/envcheck`);
});

// ---------------------------------------------------------------------------
// Credentials-family providers (credentials / password / anonymous)
// ---------------------------------------------------------------------------

test("credentials() defaults id to 'credentials' and stamps type", () => {
  const authorize = async () => null;
  const provider = credentials({ authorize });
  expect(provider.id).toBe("credentials");
  expect(provider.type).toBe("credentials");
  expect(provider.authorize).toBe(authorize);
});

test("credentials() preserves a custom id", () => {
  const provider = credentials({ id: "my-creds", authorize: async () => null });
  expect(provider.id).toBe("my-creds");
});

test("password() emits a credentials provider with a default scrypt crypto", () => {
  const provider = password();
  expect(provider.id).toBe("password");
  expect(provider.type).toBe("credentials");
  expect(typeof provider.authorize).toBe("function");
  expect(typeof provider.crypto?.hashSecret).toBe("function");
  expect(typeof provider.crypto?.verifySecret).toBe("function");
  // With neither reset nor verify configured, both extra-provider slots are undefined.
  expect(provider.extraProviders).toEqual([undefined, undefined]);
});

test("password() accepts a custom id and registers reset/verify as extra providers", () => {
  const resetProvider = email({ from: "a@b.com", send: async () => {} });
  const verifyProvider = email({ from: "a@b.com", send: async () => {}, id: "verify-email" });
  const provider = password({
    id: "pw2",
    reset: resetProvider,
    verify: verifyProvider,
  });
  expect(provider.id).toBe("pw2");
  expect(provider.extraProviders).toEqual([resetProvider, verifyProvider]);
});

test("password() lets a caller override the crypto helpers", () => {
  const crypto = {
    hashSecret: async () => "custom-hash" as never,
    verifySecret: async () => true,
  };
  const provider = password({ crypto });
  expect(provider.crypto).toBe(crypto);
});

test("anonymous() emits a credentials provider defaulting id to 'anonymous'", () => {
  const provider = anonymous();
  expect(provider.id).toBe("anonymous");
  expect(provider.type).toBe("credentials");
  expect(typeof provider.authorize).toBe("function");
});

// ---------------------------------------------------------------------------
// Email / phone providers
// ---------------------------------------------------------------------------

test("email() defaults id/name/maxAge and trims the from address", () => {
  const send = async () => {};
  const provider = email({ from: "  Acme <no-reply@acme.com>  ", send });
  expect(provider.id).toBe("email");
  expect(provider.type).toBe("email");
  expect(provider.name).toBe("Email");
  expect(provider.from).toBe("Acme <no-reply@acme.com>");
  expect(provider.maxAge).toBe(60 * 60 * 24);
  expect(provider.options).toEqual({ from: "Acme <no-reply@acme.com>" });
  expect(provider.authorize).toBeUndefined();
  expect(typeof provider.sendVerificationRequest).toBe("function");
});

test("email() rejects an empty from address", () => {
  expect(() => email({ from: "   ", send: async () => {} })).toThrow("non-empty `from`");
});

test("email() honors a custom id and maxAge", () => {
  const provider = email({ from: "a@b.com", send: async () => {}, id: "magic", maxAge: 900 });
  expect(provider.id).toBe("magic");
  expect(provider.maxAge).toBe(900);
});

test("phone() defaults id/type and a 20-minute maxAge", () => {
  const send = async () => {};
  const provider = phone({ send });
  expect(provider.id).toBe("phone");
  expect(provider.type).toBe("phone");
  expect(provider.maxAge).toBe(60 * 20);
  expect(provider.sendVerificationRequest).toBe(send);
  expect(typeof provider.authorize).toBe("function");
});

// ---------------------------------------------------------------------------
// Factor / flow providers (totp / passkey / device / connection)
// ---------------------------------------------------------------------------

test("totp() emits documented defaults (ConvexAuth issuer, 6 digits, 30s)", () => {
  const provider = totp();
  expect(provider.id).toBe("totp");
  expect(provider.type).toBe("totp");
  expect(provider.options).toEqual({ issuer: "ConvexAuth", digits: 6, period: 30 });
});

test("totp() forwards issuer/digits/period overrides", () => {
  const provider = totp({ issuer: "My App", digits: 8, period: 60 });
  expect(provider.options).toEqual({ issuer: "My App", digits: 8, period: 60 });
});

test("passkey() emits secure WebAuthn defaults", () => {
  const provider = passkey();
  expect(provider.id).toBe("passkey");
  expect(provider.type).toBe("passkey");
  expect(provider.options).toMatchObject({
    attestation: "none",
    userVerification: "required",
    residentKey: "preferred",
    algorithms: [-7, -257],
    challengeExpirationMs: 300_000,
  });
});

test("passkey() merges caller options over the defaults", () => {
  const provider = passkey({
    rpName: "My App",
    rpId: "app.example",
    userVerification: "preferred",
  });
  expect(provider.options).toMatchObject({
    rpName: "My App",
    rpId: "app.example",
    userVerification: "preferred",
    // Untouched defaults still present.
    attestation: "none",
    algorithms: [-7, -257],
  });
});

test("device() emits RFC 8628 defaults (charset/length/expiry/interval)", () => {
  const provider = device();
  expect(provider.id).toBe("device");
  expect(provider.type).toBe("device");
  expect(provider.charset).toBe("BCDFGHJKLMNPQRSTVWXZ");
  expect(provider.userCodeLength).toBe(8);
  expect(provider.expiresIn).toBe(900);
  expect(provider.interval).toBe(5);
  expect(provider.verificationUri).toBeUndefined();
});

test("device() forwards overrides", () => {
  const provider = device({
    charset: "0123456789",
    userCodeLength: 6,
    expiresIn: 600,
    interval: 10,
    verificationUri: "https://example.com/device",
  });
  expect(provider.charset).toBe("0123456789");
  expect(provider.userCodeLength).toBe(6);
  expect(provider.expiresIn).toBe(600);
  expect(provider.interval).toBe(10);
  expect(provider.verificationUri).toBe("https://example.com/device");
});

test("connection() emits the connection provider and forwards redirectURI", () => {
  expect(connection()).toEqual({ id: "connection", type: "connection", redirectURI: undefined });
  expect(connection({ redirectURI: "https://app.example/auth/connection/callback" })).toEqual({
    id: "connection",
    type: "connection",
    redirectURI: "https://app.example/auth/connection/callback",
  });
});
