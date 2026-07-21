import { createHash } from "node:crypto";

import {
  SignJWT,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
} from "jose";
import { beforeAll, expect, test, vi } from "vite-plus/test";

type AuthorizeFactory =
  typeof import("@robelest/convex-auth/server/oauth/authorize").createAuthorizeHandler;
type TokenFactory = typeof import("@robelest/convex-auth/server/oauth/token").createTokenHandler;
type GenerateOAuthToken = typeof import("@robelest/convex-auth/server/tokens").generateOAuthToken;
type VerifyOAuthToken = typeof import("@robelest/convex-auth/server/tokens").verifyOAuthToken;

let createAuthorizeHandler: AuthorizeFactory;
let createTokenHandler: TokenFactory;
let generateOAuthToken: GenerateOAuthToken;
let verifyOAuthToken: VerifyOAuthToken;

beforeAll(async () => {
  process.env.CONVEX_SITE_URL = "https://example.convex.site";
  const keys = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(keys.privateKey);
  process.env.JWKS = JSON.stringify({
    keys: [{ use: "sig", ...(await exportJWK(keys.publicKey)) }],
  });
  vi.resetModules();
  ({ createAuthorizeHandler } = await import("@robelest/convex-auth/server/oauth/authorize"));
  ({ createTokenHandler } = await import("@robelest/convex-auth/server/oauth/token"));
  ({ generateOAuthToken, verifyOAuthToken } = await import("@robelest/convex-auth/server/tokens"));
});

const MCP_RESOURCE = "https://example.convex.site/mcp";

const REDIRECT_URI = "https://app.example/cb";
const tokenDeps = {
  issuer: () => "https://example.convex.site/auth",
};

const confidentialClient = {
  _id: "client1",
  clientId: "oc_test",
  clientSecretHash: "deadbeef",
  name: "Test",
  redirectUris: [REDIRECT_URI],
  scopes: ["workspace:read", "workspace:write"],
  grantTypes: ["authorization_code", "client_credentials"],
  isArchived: false,
};
const publicClient = { ...confidentialClient, clientSecretHash: undefined };

const ctxWithUser = { auth: { getUserIdentity: async () => ({ subject: "user1" }) } } as never;

const refreshStubs = {
  createRefresh: async () => ({ refreshToken: "rt_test" }),
  exchangeRefresh: async () => null,
};

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function authorizeRequest(params: Record<string, string>): Request {
  const url = new URL("https://example.convex.site/auth/oauth2/authorize");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

function tokenRequest(params: Record<string, string>): Request {
  return new Request("https://example.convex.site/auth/oauth2/token", {
    method: "POST",
    body: new URLSearchParams(params).toString(),
  });
}

// ── authorize endpoint (H1) ────────────────────────────────────────────────

test("H1: an unregistered redirect_uri is NOT redirected to (open-redirect fix)", async () => {
  const handler = createAuthorizeHandler({
    getClient: async () => publicClient as never,
    consentPage: "/oauth/authorize",
    authSiteUrl: () => "https://example.convex.site/auth",
  });
  // response_type omitted + an attacker-controlled, unregistered redirect_uri.
  const res = await handler(
    ctxWithUser,
    authorizeRequest({
      client_id: "oc_test",
      redirect_uri: "https://evil.example",
      code_challenge: "abc",
    }),
  );
  expect(res.status).toBe(400);
  expect(res.headers.get("Location")).toBeNull();
});

test("H1: a registered redirect_uri still receives the error redirect", async () => {
  const handler = createAuthorizeHandler({
    getClient: async () => publicClient as never,
    consentPage: "/oauth/authorize",
    authSiteUrl: () => "https://example.convex.site/auth",
  });
  const res = await handler(
    ctxWithUser,
    authorizeRequest({
      client_id: "oc_test",
      redirect_uri: REDIRECT_URI,
      code_challenge: "abc",
      response_type: "token",
    }),
  );
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain(REDIRECT_URI);
  expect(res.headers.get("Location")).toContain("error=unsupported_response_type");
});

test("authorize: unknown client returns 401, not a redirect", async () => {
  const handler = createAuthorizeHandler({
    getClient: async () => null,
    consentPage: "/oauth/authorize",
    authSiteUrl: () => "https://example.convex.site/auth",
  });
  const res = await handler(
    ctxWithUser,
    authorizeRequest({ client_id: "nope", redirect_uri: REDIRECT_URI, code_challenge: "abc" }),
  );
  expect(res.status).toBe(401);
});

test("authorize: a valid request redirects to the authorize (consent) page", async () => {
  const handler = createAuthorizeHandler({
    getClient: async () => publicClient as never,
    consentPage: "/oauth/authorize",
    authSiteUrl: () => "https://example.convex.site/auth",
  });
  const res = await handler(
    ctxWithUser,
    authorizeRequest({
      client_id: "oc_test",
      redirect_uri: REDIRECT_URI,
      code_challenge: "abc",
      code_challenge_method: "S256",
      response_type: "code",
      scope: "workspace:read",
    }),
  );
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("/oauth/authorize");
});

// ── token endpoint (M1, PKCE, replay, L2) ───────────────────────────────────

test("M1: a confidential client must present its secret", async () => {
  const handler = createTokenHandler({
    ...tokenDeps,
    getClient: async () => confidentialClient as never,
    verifyClientSecret: async () => confidentialClient as never,
    acceptCode: async () => null,
    ...refreshStubs,
  });
  const res = await handler(
    {} as never,
    tokenRequest({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: REDIRECT_URI,
      client_id: "oc_test",
      code_verifier: "v",
    }),
  );
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe("invalid_client");
});

test("authorization_code: valid PKCE issues a signed at+jwt for the user", async () => {
  const verifier = "test-verifier-1234567890";
  const handler = createTokenHandler({
    ...tokenDeps,
    getClient: async () => publicClient as never,
    verifyClientSecret: async () => null,
    acceptCode: async (_ctx, _codeHash, clientId) =>
      ({
        userId: "user1",
        clientId,
        redirectUri: REDIRECT_URI,
        scopes: ["workspace:read"],
        codeChallenge: challengeFor(verifier),
        expiresAt: Date.now() + 60_000,
      }) as never,
    createRefresh: async () => ({ refreshToken: "rt_test" }),
    exchangeRefresh: async () => null,
  });
  const res = await handler(
    {} as never,
    tokenRequest({
      grant_type: "authorization_code",
      code: "rawcode",
      redirect_uri: REDIRECT_URI,
      client_id: "oc_test",
      code_verifier: verifier,
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.token_type).toBe("Bearer");
  expect(body.scope).toBe("workspace:read");
  const claims = decodeJwt(body.access_token);
  expect(claims.sub).toBe("user1");
  expect(claims.aud).toBe("convex");
  expect(claims.scope).toBe("workspace:read");
  expect((claims as { client_id?: string }).client_id).toBe("oc_test");
});

test("authorization_code: a public (none) client presenting a secret is rejected", async () => {
  const noneClient = { ...publicClient, tokenEndpointAuthMethod: "none" };
  const verifier = "test-verifier-1234567890";
  const handler = createTokenHandler({
    ...tokenDeps,
    getClient: async () => noneClient as never,
    verifyClientSecret: async () => null,
    acceptCode: async (_ctx, _codeHash, clientId) =>
      ({
        userId: "user1",
        clientId,
        redirectUri: REDIRECT_URI,
        scopes: ["workspace:read"],
        codeChallenge: challengeFor(verifier),
        expiresAt: Date.now() + 60_000,
      }) as never,
    ...refreshStubs,
  });
  const res = await handler(
    {} as never,
    tokenRequest({
      grant_type: "authorization_code",
      code: "rawcode",
      redirect_uri: REDIRECT_URI,
      client_id: "oc_test",
      code_verifier: verifier,
      client_secret: "should-not-be-here",
    }),
  );
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe("invalid_client");
});

test("authorization_code: PKCE mismatch is rejected", async () => {
  const handler = createTokenHandler({
    ...tokenDeps,
    getClient: async () => publicClient as never,
    verifyClientSecret: async () => null,
    acceptCode: async (_ctx, _codeHash, clientId, redirectUri, codeChallenge) => {
      const storedChallenge = challengeFor("a-different-verifier");
      if (codeChallenge !== storedChallenge || redirectUri !== REDIRECT_URI) return null;
      return {
        userId: "user1",
        clientId,
        redirectUri,
        scopes: ["workspace:read"],
        codeChallenge: storedChallenge,
        expiresAt: Date.now() + 60_000,
      } as never;
    },
    ...refreshStubs,
  });
  const res = await handler(
    {} as never,
    tokenRequest({
      grant_type: "authorization_code",
      code: "rawcode",
      redirect_uri: REDIRECT_URI,
      client_id: "oc_test",
      code_verifier: "the-real-verifier",
    }),
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid_grant");
});

test("authorization_code: a replayed code is rejected", async () => {
  const handler = createTokenHandler({
    ...tokenDeps,
    getClient: async () => publicClient as never,
    verifyClientSecret: async () => null,
    acceptCode: async () => {
      throw Object.assign(new Error("used"), { data: { code: "OAUTH_CODE_ALREADY_USED" } });
    },
    ...refreshStubs,
  });
  const res = await handler(
    {} as never,
    tokenRequest({
      grant_type: "authorization_code",
      code: "rawcode",
      redirect_uri: REDIRECT_URI,
      client_id: "oc_test",
      code_verifier: "v",
    }),
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid_grant");
});

test("unsupported grant_type is rejected", async () => {
  const handler = createTokenHandler({
    ...tokenDeps,
    getClient: async () => publicClient as never,
    verifyClientSecret: async () => null,
    acceptCode: async () => null,
    ...refreshStubs,
  });
  const res = await handler({} as never, tokenRequest({ grant_type: "password" }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("unsupported_grant_type");
});

test("L2: client_credentials uses a namespaced subject, not a bare clientId", async () => {
  const handler = createTokenHandler({
    ...tokenDeps,
    getClient: async () => confidentialClient as never,
    verifyClientSecret: async () => confidentialClient as never,
    acceptCode: async () => null,
    ...refreshStubs,
  });
  const res = await handler(
    {} as never,
    tokenRequest({
      grant_type: "client_credentials",
      client_id: "oc_test",
      client_secret: "secret",
      scope: "workspace:read",
    }),
  );
  expect(res.status).toBe(200);
  const claims = decodeJwt((await res.json()).access_token);
  expect(claims.sub).toBe("client:oc_test");
});

// ── RFC 8707 resource binding ───────────────────────────────────────────────

function authorizeHandler() {
  return createAuthorizeHandler({
    getClient: async () => publicClient as never,
    consentPage: "/oauth/authorize",
    authSiteUrl: () => "https://example.convex.site/auth",
  });
}

const validAuthorizeParams = {
  client_id: "oc_test",
  redirect_uri: REDIRECT_URI,
  code_challenge: "abc",
  code_challenge_method: "S256",
  response_type: "code",
  scope: "workspace:read",
};

test("authorize forwards a valid resource indicator to the consent page", async () => {
  const res = await authorizeHandler()(
    ctxWithUser,
    authorizeRequest({ ...validAuthorizeParams, resource: MCP_RESOURCE }),
  );
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("Location")!);
  expect(location.searchParams.get("resource")).toBe(MCP_RESOURCE);
});

test("authorize rejects a malformed or fragment-bearing resource indicator", async () => {
  for (const resource of ["not-a-url", "https://example.convex.site/mcp#frag", "ftp://x/y"]) {
    const res = await authorizeHandler()(
      ctxWithUser,
      authorizeRequest({ ...validAuthorizeParams, resource }),
    );
    expect(res.status, resource).toBe(302);
    expect(res.headers.get("Location"), resource).toContain("error=invalid_target");
  }
});

test("authorization_code binds the access token to the requested resource", async () => {
  const verifier = "test-verifier-1234567890";
  const handler = createTokenHandler({
    ...tokenDeps,
    getClient: async () => publicClient as never,
    verifyClientSecret: async () => null,
    acceptCode: async (_ctx, _codeHash, clientId) =>
      ({
        userId: "user1",
        clientId,
        redirectUri: REDIRECT_URI,
        scopes: ["workspace:read"],
        codeChallenge: challengeFor(verifier),
        resource: MCP_RESOURCE,
        expiresAt: Date.now() + 60_000,
      }) as never,
    createRefresh: async () => ({ refreshToken: "rt_test" }),
    exchangeRefresh: async () => null,
  });
  const res = await handler(
    {} as never,
    tokenRequest({
      grant_type: "authorization_code",
      code: "rawcode",
      redirect_uri: REDIRECT_URI,
      client_id: "oc_test",
      code_verifier: verifier,
    }),
  );
  expect(res.status).toBe(200);
  const claims = decodeJwt((await res.json()).access_token);
  expect((claims as { resource?: string }).resource).toBe(MCP_RESOURCE);
  expect(claims.aud).toBe("convex");
});

test("refresh_token rotation preserves the resource binding", async () => {
  const handler = createTokenHandler({
    ...tokenDeps,
    getClient: async () =>
      ({ ...publicClient, grantTypes: ["authorization_code", "refresh_token"] }) as never,
    verifyClientSecret: async () => null,
    acceptCode: async () => null,
    createRefresh: async () => ({ refreshToken: "rt_new" }),
    exchangeRefresh: async () => ({
      refreshToken: "rt_new",
      expiresAt: Date.now() + 60_000,
      userId: "user1",
      scopes: ["workspace:read"],
      resource: MCP_RESOURCE,
    }),
  });
  const res = await handler(
    {} as never,
    tokenRequest({ grant_type: "refresh_token", refresh_token: "rt_old", client_id: "oc_test" }),
  );
  expect(res.status).toBe(200);
  const claims = decodeJwt((await res.json()).access_token);
  expect((claims as { resource?: string }).resource).toBe(MCP_RESOURCE);
});

test("refresh_token with broader scope is rejected without rotating", async () => {
  let exchangeCalledWith: { requestedScopes?: string[] } | null = null;
  const handler = createTokenHandler({
    ...tokenDeps,
    getClient: async () =>
      ({ ...publicClient, grantTypes: ["authorization_code", "refresh_token"] }) as never,
    verifyClientSecret: async () => null,
    acceptCode: async () => null,
    createRefresh: async () => ({ refreshToken: "rt_new" }),
    exchangeRefresh: async (_ctx, args) => {
      exchangeCalledWith = args;
      return { scopeExceeded: true };
    },
  });
  const res = await handler(
    {} as never,
    tokenRequest({
      grant_type: "refresh_token",
      refresh_token: "rt_old",
      client_id: "oc_test",
      scope: "workspace:read workspace:admin",
    }),
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid_scope");
  expect(exchangeCalledWith!.requestedScopes).toEqual(["workspace:read", "workspace:admin"]);
});

test("verifyOAuthToken enforces the resource binding (MCP audience check)", async () => {
  const bound = await generateOAuthToken({
    userId: "user1",
    clientId: "oc_test",
    scopes: ["workspace:read"],
    resource: MCP_RESOURCE,
  });
  expect(await verifyOAuthToken(bound, { resource: MCP_RESOURCE })).not.toBeNull();
  expect((await verifyOAuthToken(bound))?.resource).toBe(MCP_RESOURCE);
  expect(
    await verifyOAuthToken(bound, { resource: "https://example.convex.site/other" }),
  ).toBeNull();

  const unbound = await generateOAuthToken({ userId: "user1", clientId: "oc_test", scopes: [] });
  expect((await verifyOAuthToken(unbound))?.resource).toBeNull();
  expect(await verifyOAuthToken(unbound, { resource: MCP_RESOURCE })).toBeNull();
});

test("access tokens carry token_use and no at+jwt typ header (Convex-identity compatible)", async () => {
  const token = await generateOAuthToken({
    userId: "user1",
    clientId: "oc_test",
    scopes: ["workspace:read"],
  });
  expect(decodeProtectedHeader(token).typ).toBeUndefined();
  const claims = decodeJwt(token);
  expect(claims.token_use).toBe("access");
  expect(claims.aud).toBe("convex");
  expect((await verifyOAuthToken(token))?.userId).toBe("user1");
});

test("verifyOAuthToken rejects a session-shaped token (no token_use / client_id)", async () => {
  const privateKey = await importPKCS8(process.env.JWT_PRIVATE_KEY!, "EdDSA");
  const sessionToken = await new SignJWT({ sub: "user1", aud: "convex" })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .setIssuer("https://example.convex.site/auth")
    .setExpirationTime("5m")
    .sign(privateKey);
  expect(await verifyOAuthToken(sessionToken)).toBeNull();
});

// ── refresh_token grant-types policy ────────────────────────────────────────

const refreshGrantClient = {
  ...publicClient,
  grantTypes: ["authorization_code", "refresh_token"],
};

function codeExchangeHandler(client: typeof publicClient, verifier: string) {
  return createTokenHandler({
    ...tokenDeps,
    getClient: async () => client as never,
    verifyClientSecret: async () => null,
    acceptCode: async (_ctx, _codeHash, clientId) =>
      ({
        userId: "user1",
        clientId,
        redirectUri: REDIRECT_URI,
        scopes: ["workspace:read"],
        codeChallenge: challengeFor(verifier),
        expiresAt: Date.now() + 60_000,
      }) as never,
    createRefresh: async () => ({ refreshToken: "rt_issued" }),
    exchangeRefresh: async () => null,
  });
}

test("authorization_code issues a refresh token only when the client allows the refresh_token grant", async () => {
  const verifier = "policy-verifier-123456";
  const withGrant = await codeExchangeHandler(refreshGrantClient, verifier)(
    {} as never,
    tokenRequest({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: REDIRECT_URI,
      client_id: "oc_test",
      code_verifier: verifier,
    }),
  );
  expect((await withGrant.json()).refresh_token).toBe("rt_issued");

  // publicClient's grantTypes are ["authorization_code", "client_credentials"] — no refresh_token.
  const withoutGrant = await codeExchangeHandler(publicClient, verifier)(
    {} as never,
    tokenRequest({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: REDIRECT_URI,
      client_id: "oc_test",
      code_verifier: verifier,
    }),
  );
  const body = await withoutGrant.json();
  expect(body.access_token).toBeTruthy();
  expect(body.refresh_token).toBeUndefined();
});

test("refresh_token exchange is refused for a client without the refresh_token grant", async () => {
  const exchangeRefresh = async () => ({
    refreshToken: "rt_new",
    expiresAt: Date.now() + 60_000,
    userId: "user1",
    scopes: ["workspace:read"],
  });
  const refused = await createTokenHandler({
    ...tokenDeps,
    getClient: async () => publicClient as never,
    verifyClientSecret: async () => null,
    acceptCode: async () => null,
    createRefresh: async () => ({ refreshToken: "rt" }),
    exchangeRefresh,
  })(
    {} as never,
    tokenRequest({ grant_type: "refresh_token", refresh_token: "rt_old", client_id: "oc_test" }),
  );
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toBe("unauthorized_client");

  const allowed = await createTokenHandler({
    ...tokenDeps,
    getClient: async () => refreshGrantClient as never,
    verifyClientSecret: async () => null,
    acceptCode: async () => null,
    createRefresh: async () => ({ refreshToken: "rt" }),
    exchangeRefresh,
  })(
    {} as never,
    tokenRequest({ grant_type: "refresh_token", refresh_token: "rt_old", client_id: "oc_test" }),
  );
  expect(allowed.status).toBe(200);
  expect((await allowed.json()).access_token).toBeTruthy();
});

test("authorization_code degrades to an access-token-only response when refresh-grant creation fails", async () => {
  // The single-use code is consumed by `acceptCode` in a separate component
  // transaction; if refresh-grant creation then fails the endpoint must NOT 500
  // (which would force the client through a full re-authorization even though a
  // valid access token was minted) — it issues the access token without a refresh
  // token, per RFC 6749 §5.1.
  const verifier = "degrade-verifier-123456";
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await createTokenHandler({
      ...tokenDeps,
      getClient: async () => refreshGrantClient as never,
      verifyClientSecret: async () => null,
      acceptCode: async (_ctx, _codeHash, clientId) =>
        ({
          userId: "user1",
          clientId,
          redirectUri: REDIRECT_URI,
          scopes: ["workspace:read"],
          codeChallenge: challengeFor(verifier),
          expiresAt: Date.now() + 60_000,
        }) as never,
      createRefresh: async () => {
        throw new Error("refresh grant mint failed");
      },
      exchangeRefresh: async () => null,
    })(
      {} as never,
      tokenRequest({
        grant_type: "authorization_code",
        code: "rawcode",
        redirect_uri: REDIRECT_URI,
        client_id: "oc_test",
        code_verifier: verifier,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});
