import { sha256 } from "@oslojs/crypto/sha2";
import { decodeBase64, encodeBase64urlNoPadding } from "@oslojs/encoding";
import type { GenericActionCtx, GenericDataModel } from "convex/server";

import { sha256 as sha256Hex } from "../random";
import type { EmitAuthEventInput } from "../events";
import { OAUTH_ACCESS_TOKEN_DURATION_S, generateOAuthToken } from "../tokens";
import type { OAuthClientDoc } from "./client";
import type { OAuthCodeRecord } from "./code";
import { checkOAuthGrant, type OAuthGrantDenial } from "./grant";
import type { OAuthRefreshGrant } from "./refresh";

export type { OAuthCodeRecord };

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** A rotated refresh token plus the {@link OAuthRefreshGrant} it carries. */
export type OAuthRefreshRotation = { refreshToken: string; expiresAt: number } & OAuthRefreshGrant;

/** Dependencies injected by the runtime into the token handler. */
export interface OAuthTokenDeps {
  issuer: () => string;
  getClient: (
    ctx: GenericActionCtx<GenericDataModel>,
    clientId: string,
  ) => Promise<OAuthClientDoc | null>;
  /**
   * Read a code before consumption so access-token signing can complete before
   * the one-time code is burned. Production supplies this; it remains optional
   * for custom handler integrations that accept the older dependency shape.
   */
  getCode?: (
    ctx: GenericActionCtx<GenericDataModel>,
    codeHash: string,
  ) => Promise<OAuthCodeRecord | null>;
  /** Test/integration override for the access-token signer. */
  generateAccessToken?: typeof generateOAuthToken;
  verifyClientSecret: (
    ctx: GenericActionCtx<GenericDataModel>,
    clientId: string,
    clientSecret: string,
  ) => Promise<OAuthClientDoc | null>;
  acceptCode: (
    ctx: GenericActionCtx<GenericDataModel>,
    codeHash: string,
    clientId: string,
    redirectUri: string,
    codeChallenge: string,
    refresh?: { tokenHash: string; expiresAt: number },
  ) => Promise<OAuthCodeRecord | null>;
  /**
   * Generate a refresh secret + lookup hash + expiry without persisting it, so
   * the token exchange can hand `{ tokenHash, expiresAt }` to `acceptCode` and
   * have the refresh grant/token minted in the code-consumption transaction.
   */
  mintRefresh: () => Promise<{ refreshToken: string; tokenHash: string; expiresAt: number }>;
  /**
   * Rotate a presented refresh token; `null` if invalid/expired/replayed, or
   * `{ scopeExceeded: true }` (without rotating) if `requestedScopes` is broader
   * than the grant.
   */
  exchangeRefresh: (
    ctx: GenericActionCtx<GenericDataModel>,
    args: { refreshToken: string; clientId: string; requestedScopes?: string[] },
  ) => Promise<OAuthRefreshRotation | { scopeExceeded: true } | null>;
  emitEvent?: <K extends EmitAuthEventInput["kind"]>(
    ctx: GenericActionCtx<GenericDataModel>,
    event: EmitAuthEventInput<K>,
  ) => Promise<unknown>;
}

/**
 * RFC 6749 §5.2 token-error response. `Cache-Control: no-store` is set on every
 * token response (including errors); a `401 invalid_client` additionally carries
 * a `WWW-Authenticate: Basic realm="token"` challenge (`client_secret_basic` is
 * a supported auth method).
 */
function jsonError(status: number, error: string, description: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (status === 401 && error === "invalid_client") {
    headers["WWW-Authenticate"] = 'Basic realm="token"';
  }
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers,
  });
}

function jsonOk(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Token/grant state is already committed when these audit hooks run. Never
 * turn an event sink outage into a response failure that hides a newly issued
 * one-time credential from the client.
 */
async function emitTokenEventSafely<K extends EmitAuthEventInput["kind"]>(
  ctx: GenericActionCtx<GenericDataModel>,
  deps: OAuthTokenDeps,
  event: EmitAuthEventInput<K>,
): Promise<void> {
  try {
    await deps.emitEvent?.(ctx, event);
  } catch (err) {
    console.error("[auth] OAuth token issued but audit event emission failed", {
      kind: event.kind,
      err,
    });
  }
}

async function parseBody(request: Request): Promise<URLSearchParams | null> {
  try {
    const text = await request.text();
    return new URLSearchParams(text);
  } catch {
    return null;
  }
}

function safeDecodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Merge HTTP Basic client credentials (`client_secret_basic`, RFC 6749 §2.3.1)
 * into the request params. Many OAuth/MCP clients authenticate the token
 * endpoint with `Authorization: Basic base64(client_id:client_secret)` rather
 * than form fields, so without this `client_id` would appear missing. Body
 * params take precedence when both are present.
 */
function applyBasicAuthCredentials(request: Request, params: URLSearchParams): void {
  const header = request.headers.get("authorization");
  if (header === null || !/^basic\s/i.test(header)) return;
  let decoded: string;
  try {
    decoded = utf8Decoder.decode(decodeBase64(header.replace(/^basic\s+/i, "").trim()));
  } catch {
    return;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return;
  const clientId = safeDecodeComponent(decoded.slice(0, sep));
  const clientSecret = safeDecodeComponent(decoded.slice(sep + 1));
  if (clientId && params.get("client_id") === null) params.set("client_id", clientId);
  if (clientSecret && params.get("client_secret") === null) {
    params.set("client_secret", clientSecret);
  }
}

/**
 * Authenticate a client at the token endpoint against its stored
 * `tokenEndpointAuthMethod` (RFC 7591 §2). The load-bearing distinction is
 * public vs confidential: a public (`none`) client presents no secret and is
 * proven by PKCE alone — presenting a secret is rejected (RFC 6749 §2.3 forbids
 * more than one auth method); a confidential client must present and verify its
 * secret. Among the two confidential methods (`client_secret_basic` /
 * `client_secret_post`) the secret is accepted from either channel — the caller
 * folds a Basic header into `client_secret` upstream — for interop with clients
 * that are loose about which channel they use; the method is not enforced
 * strictly between basic and post. Returns `null` on success, or the error
 * `Response` to return.
 *
 * The fallback keeps un-backfilled rows safe: a row with a stored secret hash
 * behaves confidential and one without behaves public — identical to the prior
 * "secret exists" behavior until the backfill migration runs.
 */
async function authenticateClient(
  ctx: GenericActionCtx<GenericDataModel>,
  client: OAuthClientDoc,
  clientId: string,
  clientSecret: string | null,
  deps: OAuthTokenDeps,
): Promise<Response | null> {
  const method =
    client.tokenEndpointAuthMethod ?? (client.clientSecretHash ? "client_secret_post" : "none");
  if (method === "none") {
    return clientSecret
      ? jsonError(401, "invalid_client", "Public client must not present a client secret.")
      : null;
  }
  if (!clientSecret) {
    return jsonError(401, "invalid_client", "Client authentication required.");
  }
  const authed = await deps.verifyClientSecret(ctx, clientId, clientSecret);
  return authed ? null : jsonError(401, "invalid_client", "Client authentication failed.");
}

async function handleAuthorizationCode(
  ctx: GenericActionCtx<GenericDataModel>,
  p: URLSearchParams,
  deps: OAuthTokenDeps,
): Promise<Response> {
  const code = p.get("code");
  const redirectUri = p.get("redirect_uri");
  const clientId = p.get("client_id");
  const codeVerifier = p.get("code_verifier");
  const clientSecret = p.get("client_secret");

  if (!code || !redirectUri || !clientId || !codeVerifier) {
    const missing = [
      !code && "code",
      !redirectUri && "redirect_uri",
      !clientId && "client_id",
      !codeVerifier && "code_verifier",
    ].filter(Boolean);
    return jsonError(400, "invalid_request", `Missing required parameter: ${missing.join(", ")}.`);
  }

  const client = await deps.getClient(ctx, clientId);
  if (!client || client.revoked) {
    return jsonError(401, "invalid_client", "Unknown or inactive client.");
  }

  const authError = await authenticateClient(ctx, client, clientId, clientSecret, deps);
  if (authError) return authError;

  const grant = checkOAuthGrant({ client, grantType: "authorization_code", requestedScopes: [] });
  if (!grant.ok && grant.denial.reason === "grant_type_not_allowed") {
    return jsonError(400, "unauthorized_client", "Grant type not allowed for this client.");
  }

  const codeHash = await sha256Hex(code);
  const expectedChallenge = encodeBase64urlNoPadding(sha256(utf8Encoder.encode(codeVerifier)));

  // Signing can fail independently (for example, during key/configuration
  // rollover). Complete that fallible work before the single-use code and its
  // refresh grant are committed. The final accept mutation remains the
  // authority: a concurrent exchange may still win, in which case this locally
  // generated token is discarded and never returned.
  let accessToken: string | undefined;
  if (deps.getCode !== undefined) {
    const preview = await deps.getCode(ctx, codeHash);
    if (
      preview === null ||
      preview.clientId !== clientId ||
      preview.redirectUri !== redirectUri ||
      preview.codeChallenge !== expectedChallenge ||
      preview.usedAt !== undefined ||
      preview.expiresAt < Date.now()
    ) {
      return jsonError(400, "invalid_grant", "Authorization code is invalid or expired.");
    }
    accessToken = await (deps.generateAccessToken ?? generateOAuthToken)({
      userId: preview.userId,
      clientId,
      scopes: preview.scopes,
      issuer: deps.issuer(),
      resource: preview.resource,
    });
  }

  // Pre-mint the refresh secret (CSPRNG requires an action) BEFORE consuming the
  // code, so `acceptCode` can persist the refresh grant + token in the SAME
  // component transaction that burns the code. If the code is invalid the minted
  // secret is simply discarded (never persisted); if the accept transaction
  // fails, BOTH the code consumption and the refresh insert roll back and the
  // client can retry — no more "code burned, but no refresh token" degradation.
  const mintedRefresh = client.grantTypes.includes("refresh_token")
    ? await deps.mintRefresh()
    : null;

  // `redirect_uri` and PKCE are validated atomically inside `acceptCode`, so a
  // wrong value returns `null` WITHOUT consuming a legitimate code.
  let doc: OAuthCodeRecord | null;
  try {
    doc = await deps.acceptCode(
      ctx,
      codeHash,
      clientId,
      redirectUri,
      expectedChallenge,
      mintedRefresh === null
        ? undefined
        : { tokenHash: mintedRefresh.tokenHash, expiresAt: mintedRefresh.expiresAt },
    );
  } catch (err: unknown) {
    const errCode =
      err instanceof Error && "data" in err
        ? (err.data as { code?: string } | undefined)?.code
        : undefined;
    if (errCode === "OAUTH_CODE_ALREADY_USED" || errCode === "OAUTH_CODE_EXPIRED") {
      return jsonError(400, "invalid_grant", "Authorization code is invalid or expired.");
    }
    throw err;
  }

  if (!doc) return jsonError(400, "invalid_grant", "Authorization code is invalid or expired.");

  accessToken ??= await (deps.generateAccessToken ?? generateOAuthToken)({
    userId: doc.userId,
    clientId,
    scopes: doc.scopes,
    issuer: deps.issuer(),
    resource: doc.resource,
  });
  // The refresh grant + token were persisted atomically with the code inside
  // `acceptCode`, so reaching here means the pre-minted secret is now valid.
  const refreshToken: string | undefined = mintedRefresh?.refreshToken;
  await emitTokenEventSafely(ctx, deps, {
    kind: "oauth.token.exchanged",
    actor: { type: "oauth_client", id: clientId },
    subject: { type: "oauth_client", id: clientId },
    targets: [
      { kind: "oauth_client", id: clientId },
      { kind: "user", id: doc.userId },
    ],
    outcome: "success",
    data: {
      clientId,
      scopes: doc.scopes,
      grantType: "authorization_code",
    },
  });

  return jsonOk({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: OAUTH_ACCESS_TOKEN_DURATION_S,
    scope: doc.scopes.join(" "),
    ...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}),
  });
}

async function handleRefreshToken(
  ctx: GenericActionCtx<GenericDataModel>,
  p: URLSearchParams,
  deps: OAuthTokenDeps,
): Promise<Response> {
  const refreshToken = p.get("refresh_token");
  const clientId = p.get("client_id");
  const clientSecret = p.get("client_secret");
  const scope = p.get("scope");

  if (!refreshToken || !clientId) {
    const missing = [!refreshToken && "refresh_token", !clientId && "client_id"].filter(Boolean);
    return jsonError(400, "invalid_request", `Missing required parameter: ${missing.join(", ")}.`);
  }

  const client = await deps.getClient(ctx, clientId);
  if (!client || client.revoked) {
    return jsonError(401, "invalid_client", "Unknown or inactive client.");
  }

  const authError = await authenticateClient(ctx, client, clientId, clientSecret, deps);
  if (authError) return authError;

  const grant = checkOAuthGrant({ client, grantType: "refresh_token", requestedScopes: [] });
  if (!grant.ok && grant.denial.reason === "grant_type_not_allowed") {
    return jsonError(400, "unauthorized_client", "Grant type not allowed for this client.");
  }

  const requestedScopes = scope ? scope.split(" ").filter(Boolean) : undefined;
  const rotated = await deps.exchangeRefresh(ctx, { refreshToken, clientId, requestedScopes });
  if (!rotated) {
    return jsonError(400, "invalid_grant", "Refresh token is invalid or expired.");
  }
  if ("scopeExceeded" in rotated) {
    return jsonError(400, "invalid_scope", "Requested scope exceeds the original grant.");
  }

  const scopes = requestedScopes ?? rotated.scopes;
  const accessToken = await generateOAuthToken({
    userId: rotated.userId,
    clientId,
    scopes,
    issuer: deps.issuer(),
    resource: rotated.resource,
  });
  await emitTokenEventSafely(ctx, deps, {
    kind: "oauth.token.exchanged",
    actor: { type: "oauth_client", id: clientId },
    subject: { type: "oauth_client", id: clientId },
    targets: [
      { kind: "oauth_client", id: clientId },
      { kind: "user", id: rotated.userId },
    ],
    outcome: "success",
    data: { clientId, scopes, grantType: "refresh_token" },
  });

  return jsonOk({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: OAUTH_ACCESS_TOKEN_DURATION_S,
    scope: scopes.join(" "),
    refresh_token: rotated.refreshToken,
  });
}

/** Client-credentials grant denial → its RFC 6749 token-error response. */
const CLIENT_CREDENTIALS_DENIAL: Partial<Record<OAuthGrantDenial["reason"], () => Response>> = {
  grant_type_not_allowed: () =>
    jsonError(400, "unauthorized_client", "Grant type not allowed for this client."),
  scope_not_allowed: () => jsonError(400, "invalid_scope", "Scope not permitted."),
};

async function handleClientCredentials(
  ctx: GenericActionCtx<GenericDataModel>,
  p: URLSearchParams,
  deps: OAuthTokenDeps,
): Promise<Response> {
  const clientId = p.get("client_id");
  const clientSecret = p.get("client_secret");
  const scope = p.get("scope") ?? "";

  if (!clientId || !clientSecret) {
    return jsonError(400, "invalid_request", "Missing client_id or client_secret.");
  }

  const client = await deps.verifyClientSecret(ctx, clientId, clientSecret);
  if (!client) return jsonError(401, "invalid_client", "Client authentication failed.");

  const requestedScopes = scope ? scope.split(" ").filter(Boolean) : [];
  const check = checkOAuthGrant({ client, grantType: "client_credentials", requestedScopes });
  if (!check.ok) {
    const respond = CLIENT_CREDENTIALS_DENIAL[check.denial.reason];
    return respond ? respond() : jsonError(401, "invalid_client", "Client authentication failed.");
  }
  const effectiveScopes = check.scopes;

  const accessToken = await generateOAuthToken({
    userId: `client:${clientId}`,
    clientId,
    scopes: effectiveScopes,
    issuer: deps.issuer(),
  });
  await emitTokenEventSafely(ctx, deps, {
    kind: "oauth.token.created",
    actor: { type: "oauth_client", id: clientId },
    subject: { type: "oauth_client", id: clientId },
    targets: [{ kind: "oauth_client", id: clientId }],
    outcome: "success",
    data: {
      clientId,
      scopes: effectiveScopes,
      grantType: "client_credentials",
    },
  });

  return jsonOk({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: OAUTH_ACCESS_TOKEN_DURATION_S,
    scope: effectiveScopes.join(" "),
  });
}

/**
 * Build the `POST /oauth2/token` request handler, dispatching on `grant_type`.
 *
 * For `authorization_code`: confidential clients (those with a stored secret
 * hash) must authenticate with `client_secret`; public clients rely on PKCE
 * alone. The code is single-use (consumed in-transaction), and the grant is
 * rejected unless the PKCE `S256` challenge matches and `redirect_uri` is
 * identical to the one bound to the code. For `client_credentials`: the client
 * must authenticate and may only obtain its registered scopes.
 *
 * @see https://www.rfc-editor.org/rfc/rfc6749
 * @see https://www.rfc-editor.org/rfc/rfc7636
 * @internal
 */
const GRANT_HANDLERS: Record<
  string,
  (
    ctx: GenericActionCtx<GenericDataModel>,
    params: URLSearchParams,
    deps: OAuthTokenDeps,
  ) => Promise<Response>
> = {
  authorization_code: handleAuthorizationCode,
  refresh_token: handleRefreshToken,
  client_credentials: handleClientCredentials,
};

export function createTokenHandler(deps: OAuthTokenDeps) {
  return async (ctx: GenericActionCtx<GenericDataModel>, request: Request): Promise<Response> => {
    const params = await parseBody(request);
    if (!params) {
      return jsonError(400, "invalid_request", "Could not parse request body.");
    }
    applyBasicAuthCredentials(request, params);

    const grantType = params.get("grant_type");
    const handle = grantType === null ? undefined : GRANT_HANDLERS[grantType];
    return handle
      ? handle(ctx, params, deps)
      : jsonError(400, "unsupported_grant_type", "Unsupported grant_type.");
  };
}
