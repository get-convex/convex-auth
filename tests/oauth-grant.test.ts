import type { OAuthClientDoc } from "@robelest/convex-auth/server/oauth/client";
import { checkOAuthGrant } from "@robelest/convex-auth/server/oauth/grant";
import { expect, test } from "vite-plus/test";

// Unit coverage for the single source of truth behind every OAuth trust
// boundary (authorize handler, `code.authorize` mutation, token endpoint). A
// regression in any of the four checks — client active, exact redirect_uri,
// allowed grant_type, requested scopes ⊆ client.scopes — must fail here.

const REDIRECT = "https://app.example.com/cb";

function client(overrides: Partial<OAuthClientDoc> = {}): OAuthClientDoc {
  return {
    _id: "oc_doc_1" as OAuthClientDoc["_id"],
    _creationTime: 0,
    clientId: "oc_test",
    name: "Test client",
    redirectUris: [REDIRECT],
    scopes: ["workspace:read", "workspace:write"],
    grantTypes: ["authorization_code", "refresh_token", "client_credentials"],
    tokenEndpointAuthMethod: "client_secret_post",
    revoked: false,
    ...overrides,
  };
}

test("a valid authorization_code grant passes with the requested scopes", () => {
  const result = checkOAuthGrant({
    client: client(),
    grantType: "authorization_code",
    redirectUri: REDIRECT,
    requestedScopes: ["workspace:read"],
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.scopes).toEqual(["workspace:read"]);
    expect(result.client.clientId).toBe("oc_test");
  }
});

test("an unknown client is denied as client_not_found", () => {
  const result = checkOAuthGrant({
    client: null,
    grantType: "authorization_code",
    redirectUri: REDIRECT,
    requestedScopes: [],
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.denial.reason).toBe("client_not_found");
});

test("a revoked client is denied as client_not_found", () => {
  const result = checkOAuthGrant({
    client: client({ revoked: true }),
    grantType: "authorization_code",
    redirectUri: REDIRECT,
    requestedScopes: ["workspace:read"],
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.denial.reason).toBe("client_not_found");
});

test("an unregistered redirect_uri is denied as redirect_uri_mismatch", () => {
  const result = checkOAuthGrant({
    client: client(),
    grantType: "authorization_code",
    redirectUri: "https://evil.example.com/cb",
    requestedScopes: ["workspace:read"],
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.denial.reason).toBe("redirect_uri_mismatch");
});

test("redirect_uri matching is EXACT — a prefix or extension of a registered URI is rejected", () => {
  // Each of these shares a prefix with the registered `REDIRECT` but is not an
  // exact string match, so an attacker cannot smuggle a code to a sibling path.
  for (const redirectUri of [
    `${REDIRECT}/extra`,
    `${REDIRECT}?x=1`,
    `${REDIRECT}#frag`,
    "https://app.example.com",
    "https://app.example.com.evil.com/cb",
  ]) {
    const result = checkOAuthGrant({
      client: client(),
      grantType: "authorization_code",
      redirectUri,
      requestedScopes: ["workspace:read"],
    });
    expect(result.ok, redirectUri).toBe(false);
    if (!result.ok) expect(result.denial.reason, redirectUri).toBe("redirect_uri_mismatch");
  }
});

test("a disallowed grant_type is denied as grant_type_not_allowed", () => {
  const result = checkOAuthGrant({
    client: client({ grantTypes: ["authorization_code"] }),
    grantType: "client_credentials",
    requestedScopes: [],
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.denial.reason).toBe("grant_type_not_allowed");
});

test("an over-broad scope is denied as scope_not_allowed and names the disallowed scopes", () => {
  const result = checkOAuthGrant({
    client: client(),
    grantType: "authorization_code",
    redirectUri: REDIRECT,
    requestedScopes: ["workspace:read", "workspace:admin", "workspace:delete"],
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.denial.reason).toBe("scope_not_allowed");
    if (result.denial.reason === "scope_not_allowed") {
      expect(result.denial.disallowed).toEqual(["workspace:admin", "workspace:delete"]);
    }
  }
});

test("client_credentials with no requested scopes resolves to the client's full scope set", () => {
  const result = checkOAuthGrant({
    client: client(),
    grantType: "client_credentials",
    requestedScopes: [],
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.scopes).toEqual(["workspace:read", "workspace:write"]);
});

test("authorization_code with no requested scopes does NOT widen to the client's full set", () => {
  // Only client_credentials auto-expands; an empty authorization_code request
  // must stay empty so a code is never minted with unintended scopes.
  const result = checkOAuthGrant({
    client: client(),
    grantType: "authorization_code",
    redirectUri: REDIRECT,
    requestedScopes: [],
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.scopes).toEqual([]);
});
