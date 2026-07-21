import { SignJWT, createLocalJWKSet, importPKCS8, jwtVerify } from "jose";

import type { AccessToken } from "../shared/brand";
import { envOptionalString, requireEnv } from "./env";
import { generateRandomString } from "./random";
import { ConvexAuthConfig } from "./types";
import type { SessionTokenIdentityClaims } from "./types";
import { authUrlFromEnv } from "./url";
import { withSpan } from "./utils/span";

const DEFAULT_JWT_DURATION_MS = 1000 * 60 * 60;
const TOKEN_JTI_LENGTH = 24;
const TOKEN_JTI_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

let cachedPrivateKeyPromise: Promise<Awaited<ReturnType<typeof importPKCS8>>> | null = null;
const cachedIssuers = new Map<string, string>();

const JWT_ALG = "EdDSA" as const;

function normalizePkcs8Pem(value: string) {
  const trimmed = value.trim();
  if (!trimmed.includes("-----BEGIN PRIVATE KEY-----")) {
    return trimmed;
  }

  const withEscapedNewlines = trimmed.replace(/\\n/g, "\n");
  if (withEscapedNewlines.includes("\n")) {
    return withEscapedNewlines;
  }

  const beginMarker = "-----BEGIN PRIVATE KEY-----";
  const endMarker = "-----END PRIVATE KEY-----";
  const body = trimmed.replace(beginMarker, "").replace(endMarker, "").trim().replace(/\s+/g, "");

  if (body.length === 0) {
    return trimmed;
  }

  const wrappedBody = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `${beginMarker}\n${wrappedBody}\n${endMarker}`;
}

const getPrivateKey = () => {
  if (cachedPrivateKeyPromise === null) {
    try {
      const pem = normalizePkcs8Pem(requireEnv("JWT_PRIVATE_KEY"));
      cachedPrivateKeyPromise = importPKCS8(pem, JWT_ALG).catch((error) => {
        cachedPrivateKeyPromise = null;
        throw error;
      });
    } catch (error) {
      cachedPrivateKeyPromise = null;
      throw error;
    }
  }
  return cachedPrivateKeyPromise;
};

const getIssuer = (path?: string) => {
  const key = path ?? "";
  let issuer = cachedIssuers.get(key);
  if (issuer === undefined) {
    issuer = authUrlFromEnv(path);
    cachedIssuers.set(key, issuer);
  }
  return issuer;
};

if (envOptionalString("JWT_PRIVATE_KEY")) {
  try {
    void getPrivateKey().catch((err) => {
      console.error("[auth] JWT private key pre-warm failed", { err });
    });
  } catch (err) {
    console.error("[auth] JWT private key pre-warm threw synchronously", { err });
  }
}
if (envOptionalString("CONVEX_SITE_URL")) {
  try {
    getIssuer();
  } catch (err) {
    console.error("[auth] JWT issuer pre-warm threw", { err });
  }
}

/** Lifetime of an issued OAuth access token, in seconds. Shared with the token endpoint's `expires_in`. */
export const OAUTH_ACCESS_TOKEN_DURATION_S = 900;

/**
 * Sign an OAuth access token (EdDSA) for the given user, client, and scopes.
 *
 * The `aud` claim is `"convex"` so the token is a valid Convex identity
 * (`applicationID: "convex"`) — load-bearing: MCP tools run the user's queries
 * via `ctx.runQuery`, which requires Convex's identity layer to accept this
 * token. For that reason the access token must look like an ID-token-shaped JWT:
 * it carries NO `typ: "at+jwt"` header (Convex's validator rejects that RFC 9068
 * type), and is instead marked as an access token by a positive `token_use:
 * "access"` claim, which `verifyOAuthToken` checks (alongside the `client_id`
 * claim) to tell it apart from a session token. We don't issue OIDC ID tokens,
 * so there is no id-vs-access confusion for the `at+jwt` typ to guard against.
 *
 * When an RFC 8707 `resource` is supplied the token carries a `resource` claim
 * binding it to that protected resource; an MCP endpoint rejects tokens whose
 * `resource` does not match its own canonical resource.
 *
 * @internal
 */
export async function generateOAuthToken(args: {
  userId: string;
  clientId: string;
  scopes: string[];
  issuer?: string;
  resource?: string;
}): Promise<string> {
  const privateKey = await withSpan("convex-auth.tokens.import-key", { alg: JWT_ALG }, () =>
    getPrivateKey(),
  );
  const exp = new Date(Date.now() + OAUTH_ACCESS_TOKEN_DURATION_S * 1000);
  return await withSpan("convex-auth.tokens.sign-oauth", { alg: JWT_ALG }, () =>
    new SignJWT({
      sub: args.userId,
      aud: "convex",
      token_use: "access",
      scope: args.scopes.join(" "),
      client_id: args.clientId,
      ...(args.resource !== undefined ? { resource: args.resource } : null),
    })
      .setProtectedHeader({ alg: JWT_ALG })
      .setIssuedAt()
      .setJti(generateRandomString(TOKEN_JTI_LENGTH, TOKEN_JTI_ALPHABET))
      .setIssuer(args.issuer ?? getIssuer())
      .setExpirationTime(exp)
      .sign(privateKey),
  );
}

let cachedKeySet: ReturnType<typeof createLocalJWKSet> | null = null;

/**
 * The local JWKS keyset, built once and reused. The `JWKS` env is static per
 * deployment, so caching also preserves jose's internal imported-key cache
 * across requests rather than re-importing keys on every verification.
 */
function getJwkSet(): ReturnType<typeof createLocalJWKSet> {
  if (cachedKeySet === null) {
    const jwksJson = JSON.parse(requireEnv("JWKS")) as { keys: object[] };
    cachedKeySet = createLocalJWKSet(jwksJson);
  }
  return cachedKeySet;
}

/**
 * Verify an OAuth access token against the local JWKS and issuer.
 *
 * When `opts.resource` is supplied, the token's RFC 8707 `resource` claim must
 * equal it exactly — a token bound to a different (or no) resource is rejected.
 * This is how an MCP endpoint enforces that a token was issued for *it*.
 *
 * @returns The token's user, client, scopes, and bound `resource`, or `null` if
 *   verification fails, the token is not an OAuth access token, or the resource
 *   assertion does not hold.
 * @internal
 */
export async function verifyOAuthToken(
  token: string,
  opts?: { issuer?: string; resource?: string },
): Promise<{ userId: string; clientId: string; scopes: string[]; resource: string | null } | null> {
  try {
    const { payload } = await jwtVerify(token, getJwkSet(), {
      issuer: opts?.issuer ?? getIssuer(),
      audience: "convex",
      // Defense-in-depth: pin the accepted JWS algorithm so a token can only be
      // verified under EdDSA, never coerced to a different `alg` (algorithm
      // substitution / confusion hardening).
      algorithms: [JWT_ALG],
      clockTolerance: 30,
    });
    if ((payload as { token_use?: string }).token_use !== "access") return null;
    const userId = payload.sub;
    const clientId = (payload as { client_id?: string }).client_id;
    const scope = (payload as { scope?: string }).scope ?? "";
    if (!userId || !clientId) return null;
    const resourceClaim = (payload as { resource?: unknown }).resource;
    const resource = typeof resourceClaim === "string" ? resourceClaim : null;
    if (opts?.resource !== undefined && resource !== opts.resource) return null;
    // NOTE: the returned `scopes` are ADVISORY, not a Convex-enforced capability
    // boundary. Because `aud` is "convex", Convex's identity layer accepts this
    // token as the user's full identity — any query/mutation the user could run,
    // a client bearing this token can run via `ctx.runQuery`/`ctx.runMutation`,
    // regardless of `scope`. Integrators MUST enforce these scopes app-side
    // (e.g. inside each MCP tool handler) for them to actually restrict access.
    return { userId, clientId, scopes: scope ? scope.split(" ") : [], resource };
  } catch {
    return null;
  }
}

/**
 * Sign a session access token (EdDSA) carrying the identity claims, audienced to Convex.
 *
 * Expiry is `config.jwt.durationMs` from now, defaulting to one hour.
 *
 * @internal
 */
export async function generateToken(
  args: {
    identity: SessionTokenIdentityClaims;
  },
  config: ConvexAuthConfig,
): Promise<AccessToken> {
  const privateKey = await withSpan("convex-auth.tokens.import-key", { alg: JWT_ALG }, () =>
    getPrivateKey(),
  );
  const expirationTime = new Date(Date.now() + (config.jwt?.durationMs ?? DEFAULT_JWT_DURATION_MS));
  const claims = {
    sub: args.identity.subject,
    sid: args.identity.sessionId,
    ...(args.identity.name !== undefined ? { name: args.identity.name } : null),
    ...(args.identity.email !== undefined ? { email: args.identity.email } : null),
    ...(args.identity.emailVerified !== undefined
      ? { email_verified: args.identity.emailVerified }
      : null),
    ...(args.identity.picture !== undefined ? { picture: args.identity.picture } : null),
    ...(args.identity.phoneNumber !== undefined
      ? { phone_number: args.identity.phoneNumber }
      : null),
    ...(args.identity.phoneNumberVerified !== undefined
      ? { phone_number_verified: args.identity.phoneNumberVerified }
      : null),
  };
  return (await withSpan("convex-auth.tokens.sign", { alg: JWT_ALG }, () =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: JWT_ALG })
      .setIssuedAt()
      .setJti(generateRandomString(TOKEN_JTI_LENGTH, TOKEN_JTI_ALPHABET))
      .setIssuer(getIssuer(config.path))
      .setAudience("convex")
      .setExpirationTime(expirationTime)
      .sign(privateKey),
  )) as AccessToken;
}
