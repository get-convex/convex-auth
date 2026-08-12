import { convexTest } from "convex-test";
import { SignJWT, importPKCS8 } from "jose";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
} from "./test.helpers";

// Microsoft Entra ID's discovery document returns the literal string
// `{tenantid}` as the issuer for multi-tenant authorities (`/common`,
// `/organizations`, `/consumers`). The `@auth/core` Microsoft Entra ID provider
// rewrites that placeholder via a `customFetch` hook so the initial issuer
// validation succeeds, but the real per-tenant issuer is only known after the
// token exchange, when we can read `tid` from the `id_token`.
//
// Before the fix, `@convex-dev/auth`'s callback handler skipped the
// post-token-exchange re-discovery that `@auth/core` performs for these
// providers. As a result, multi-tenant tokens were rejected by
// `processAuthorizationCodeResponse`'s issuer check, since the AS metadata
// still claimed `/common/v2.0` as the issuer while the `id_token` carried the
// per-tenant URL.
//
// These tests exercise the ported re-discovery block.

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const SPOOFED_TENANT_ID = "99999999-9999-9999-9999-999999999999";
const SHARED_AUTHORITY = "https://login.microsoftonline.com/common/v2.0";

type DiscoveryDoc = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported: string[];
  response_types_supported: string[];
  subject_types_supported: string[];
  code_challenge_methods_supported: string[];
};

function discoveryDocFor(authorityUrl: string): DiscoveryDoc {
  const baseAuthority = "https://login.microsoftonline.com";
  // Microsoft returns `{tenantid}` as a placeholder for the issuer field on
  // the multi-tenant authorities. The provider's `customFetch` hook rewrites
  // it to whatever segment is in the request URL. We mimic that response
  // shape verbatim so the provider can do its replacement.
  return {
    issuer: `${baseAuthority}/{tenantid}/v2.0`,
    authorization_endpoint: `${authorityUrl}/oauth2/v2.0/authorize`,
    token_endpoint: `${authorityUrl}/oauth2/v2.0/token`,
    userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
    jwks_uri: `${authorityUrl}/discovery/v2.0/keys`,
    id_token_signing_alg_values_supported: ["RS256"],
    response_types_supported: ["code", "id_token"],
    subject_types_supported: ["pairwise"],
    code_challenge_methods_supported: ["S256"],
  };
}

async function signIdToken(args: {
  issuer: string;
  audience: string;
  tid: string;
  sub: string;
  email: string;
  name: string;
}) {
  const privateKey = await importPKCS8(JWT_PRIVATE_KEY, "RS256");
  return await new SignJWT({
    tid: args.tid,
    email: args.email,
    name: args.name,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(args.issuer)
    .setAudience(args.audience)
    .setSubject(args.sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

function getJwks() {
  return JSON.parse(JWKS) as {
    keys: Array<Record<string, unknown>>;
  };
}

async function driveSignInUpTo(t: ReturnType<typeof convexTest>) {
  // Stub fetch for the *initial* OIDC discovery that runs lazily when
  // convex-auth materializes the provider config inside `t.fetch`.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        url ===
        `${SHARED_AUTHORITY}/.well-known/openid-configuration`
      ) {
        return new Response(JSON.stringify(discoveryDocFor(SHARED_AUTHORITY)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch (init): ${url}`);
    }),
  );

  const { redirect, verifier } = await t.action(api.auth.signIn, {
    provider: "microsoft-entra-id",
    params: {},
  });
  vi.unstubAllGlobals();

  expect(redirect).toEqual(
    expect.stringContaining(
      CONVEX_SITE_URL + "/api/auth/signin/microsoft-entra-id",
    ),
  );

  const url = new URL(redirect!);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const u = typeof input === "string" ? input : input.toString();
      if (
        u ===
        `${SHARED_AUTHORITY}/.well-known/openid-configuration`
      ) {
        return new Response(JSON.stringify(discoveryDocFor(SHARED_AUTHORITY)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch (redirect): ${u}`);
    }),
  );
  const response = await t.fetch(`${url.pathname}${url.search}`);
  vi.unstubAllGlobals();

  expect(response.status).toBe(302);
  const redirectedTo = response.headers.get("Location")!;
  const cookies = response.headers.get("Set-Cookie")!;
  const redirectedToParams = new URL(redirectedTo).searchParams;

  return { verifier, cookies, redirectedToParams };
}

async function driveCallback(
  t: ReturnType<typeof convexTest>,
  ctx: {
    verifier: string | undefined;
    cookies: string;
    redirectedToParams: URLSearchParams;
  },
  opts: {
    idTokenIssuerTenantId: string;
    idTokenTidClaim: string;
    rediscoveryReturnsTenant?: string;
  },
) {
  const callbackUrl = ctx.redirectedToParams.get("redirect_uri")!;
  const state = ctx.redirectedToParams.get("state") ?? undefined;
  const codeChallenge = ctx.redirectedToParams.get("code_challenge") ?? undefined;

  const issuedCode = "ms-entra-code";
  const issuedAccessToken = "ms-entra-access";
  const expectedTenantAuthority = `https://login.microsoftonline.com/${opts.rediscoveryReturnsTenant ?? opts.idTokenTidClaim}/v2.0`;

  // The id_token's issuer is constructed from `idTokenIssuerTenantId` so we
  // can simulate both legitimate and spoofed tokens.
  const idTokenIssuer = `https://login.microsoftonline.com/${opts.idTokenIssuerTenantId}/v2.0`;
  const audience = process.env.AUTH_MICROSOFT_ENTRA_ID_ID!;

  const idToken = await signIdToken({
    issuer: idTokenIssuer,
    audience,
    tid: opts.idTokenTidClaim,
    sub: "ms-user-1",
    email: "user@contoso.example",
    name: "Contoso User",
  });

  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const u =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // The initial discovery may be re-run here because the callback action
    // also lazily materializes the provider.
    if (u === `${SHARED_AUTHORITY}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify(discoveryDocFor(SHARED_AUTHORITY)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Token exchange.
    if (u === `${SHARED_AUTHORITY}/oauth2/v2.0/token`) {
      return new Response(
        JSON.stringify({
          access_token: issuedAccessToken,
          token_type: "Bearer",
          expires_in: 3600,
          id_token: idToken,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Re-discovery (the bit this PR is about).
    if (
      u === `${expectedTenantAuthority}/.well-known/openid-configuration`
    ) {
      return new Response(
        JSON.stringify(discoveryDocFor(expectedTenantAuthority)),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // JWKS for either authority.
    if (
      u === `${SHARED_AUTHORITY}/discovery/v2.0/keys` ||
      u === `${expectedTenantAuthority}/discovery/v2.0/keys`
    ) {
      return new Response(JSON.stringify(getJwks()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch (callback): ${u}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  // `Set-Cookie` values returned by `Headers.get` are joined with `, ` but
  // commas also appear inside `Expires=...` dates. Split on the cookie
  // boundary (`,` followed by a space and a token character) instead of just
  // `,` so we don't mangle the nonce cookie.
  const cookieHeader = ctx.cookies
    .split(/,(?=\s*[A-Za-z0-9_-]+=)/)
    .map((cookie) => {
      const [name, value] = cookie.split(";")[0].split("=");
      return `${name.trim()}=${value};`;
    })
    .join(" ");

  const callbackParams = new URLSearchParams({ code: issuedCode });
  if (state) callbackParams.set("state", state);
  if (codeChallenge) callbackParams.set("code_challenge", codeChallenge);

  const callbackResponse = await t.fetch(
    `${new URL(callbackUrl).pathname}?${callbackParams.toString()}`,
    {
      headers: { Cookie: cookieHeader },
    },
  );

  vi.unstubAllGlobals();

  return { callbackResponse, fetchMock, verifier: ctx.verifier };
}

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_MICROSOFT_ENTRA_ID_ID = "ms-entra-client-id";
  process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET = "ms-entra-client-secret";
  process.env.AUTH_LOG_LEVEL = "ERROR";
}

describe("microsoft entra id multi-tenant issuer re-discovery", () => {
  test("accepts an id_token whose issuer matches the tid claim", async () => {
    setupEnv();
    const t = convexTest(schema);
    const ctx = await driveSignInUpTo(t);

    const { callbackResponse, fetchMock } = await driveCallback(
      t,
      ctx,
      {
        idTokenIssuerTenantId: TENANT_ID,
        idTokenTidClaim: TENANT_ID,
      },
    );

    expect(callbackResponse.status).toBe(302);

    // The re-discovery endpoint for the real tenant must have been hit.
    const requestedUrls = fetchMock.mock.calls.map((c) => {
      const input = c[0];
      return typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    });
    expect(requestedUrls).toContain(
      `https://login.microsoftonline.com/${TENANT_ID}/v2.0/.well-known/openid-configuration`,
    );

    const finalRedirectedTo = callbackResponse.headers.get("Location")!;
    // The callback redirected the browser back to the app with an auth code.
    // Before the fix, this redirect would have included an `error=` query
    // string instead (because the issuer mismatch made the token exchange
    // throw). Asserting on the presence of a non-null `code` query param is
    // sufficient to demonstrate the re-discovery succeeded.
    const code = new URL(finalRedirectedTo).searchParams.get("code");
    expect(code).not.toBeNull();
  });

  test("rejects an id_token whose issuer does not match the tid claim", async () => {
    setupEnv();
    const t = convexTest(schema);
    const ctx = await driveSignInUpTo(t);

    // The id_token claims `tid=TENANT_ID`, so we re-discover against
    // `TENANT_ID/v2.0`, but the token itself was issued by the spoofed tenant.
    const { callbackResponse } = await driveCallback(t, ctx, {
      idTokenIssuerTenantId: SPOOFED_TENANT_ID,
      idTokenTidClaim: TENANT_ID,
    });

    // The callback handler turns the OAuth error into a redirect with an
    // `error` query param rather than throwing, but importantly the response
    // is NOT a successful 302 to the SITE_URL with a code.
    expect(callbackResponse.status).toBe(302);
    const location = callbackResponse.headers.get("Location")!;
    expect(location).not.toContain("?code=");
  });
});
