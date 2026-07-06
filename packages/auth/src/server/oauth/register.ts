import type { GenericActionCtx, GenericDataModel } from "convex/server";

import type { OAuthTokenEndpointAuthMethod } from "./client";

/** Grant types every DCR/RFC-7592 client is registered with (never client-supplied). */
export const DCR_GRANT_TYPES = ["authorization_code", "refresh_token"];

/** Dependencies injected by the runtime into the registration handler. */
export interface OAuthRegisterDeps {
  /** Create an OAuth client. A confidential client returns a one-time
   *  `clientSecret`; a public (`none`) client returns none. Both return the
   *  one-time RFC 7592 `registrationAccessToken`. */
  createClient: (
    ctx: GenericActionCtx<GenericDataModel>,
    opts: {
      name: string;
      redirectUris: string[];
      scopes: string[];
      grantTypes: string[];
      tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
    },
  ) => Promise<{
    clientId: string;
    clientSecret?: string;
    registrationAccessToken: string;
    tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
  }>;
  /** Scopes the server is willing to grant; requested scopes are clamped to this set. */
  allowedScopes: string[];
  /** Build the RFC 7592 `registration_client_uri` for a freshly-issued client id. */
  registrationClientUri: (clientId: string) => string;
}

/** @internal */
export function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** @internal */
export function isValidRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/** Validated, server-clamped client metadata shared by DCR `POST` and 7592 `PUT`. */
export interface ValidatedClientMetadata {
  name: string;
  redirectUris: string[];
  scopes: string[];
  tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
}

const AUTH_METHODS = ["client_secret_basic", "client_secret_post", "none"] as const;

/**
 * Validate and clamp client-registration metadata (RFC 7591 §2). Re-used by
 * both DCR registration and RFC 7592 updates so a client can never `PUT` itself
 * a redirect URI or scope it could not have registered with: `redirect_uris`
 * must be https or http-loopback, scopes are intersected with `allowedScopes`,
 * and `token_endpoint_auth_method` must be one of the supported values
 * (defaulting to `client_secret_post`). `grant_types` are server-fixed and not
 * read from the request.
 */
export function validateClientMetadata(
  body: Record<string, unknown>,
  allowedScopes: string[],
): { ok: true; value: ValidatedClientMetadata } | { ok: false; response: Response } {
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  if (redirectUris.length === 0) {
    return {
      ok: false,
      response: jsonError(400, "invalid_redirect_uri", "At least one redirect_uri is required."),
    };
  }
  if (!redirectUris.every(isValidRedirectUri)) {
    return {
      ok: false,
      response: jsonError(
        400,
        "invalid_redirect_uri",
        "redirect_uris must be https or http://localhost.",
      ),
    };
  }

  const requested = typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [];
  const allowed = new Set(allowedScopes);
  const scopes =
    requested.length > 0 ? requested.filter((s) => allowed.has(s)) : [...allowedScopes];

  const name =
    typeof body.client_name === "string" && body.client_name.trim().length > 0
      ? body.client_name.trim()
      : "MCP client";

  const method = body.token_endpoint_auth_method;
  if (method !== undefined && !AUTH_METHODS.includes(method as (typeof AUTH_METHODS)[number])) {
    return {
      ok: false,
      response: jsonError(
        400,
        "invalid_client_metadata",
        "Unsupported token_endpoint_auth_method.",
      ),
    };
  }

  return {
    ok: true,
    value: {
      name,
      redirectUris,
      scopes,
      tokenEndpointAuthMethod:
        (method as OAuthTokenEndpointAuthMethod | undefined) ?? "client_secret_post",
    },
  };
}

/**
 * Build the public RFC 7591/7592 client-metadata JSON shared by registration
 * and management responses. One-time credentials (`client_secret`,
 * `registration_access_token`) are added by the caller, never re-disclosed by
 * `GET`/`PUT`.
 */
export function clientMetadataBody(opts: {
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
  registrationClientUri: string;
}): Record<string, unknown> {
  return {
    client_id: opts.clientId,
    client_name: opts.name,
    redirect_uris: opts.redirectUris,
    grant_types: DCR_GRANT_TYPES,
    response_types: ["code"],
    token_endpoint_auth_method: opts.tokenEndpointAuthMethod,
    scope: opts.scopes.join(" "),
    registration_client_uri: opts.registrationClientUri,
  };
}

/**
 * RFC 7591 Dynamic Client Registration handler.
 *
 * Registers an OAuth client from an unauthenticated `POST` so MCP clients can
 * self-register. A confidential client (the default, or an explicit
 * `client_secret_post`/`client_secret_basic`) is issued a `client_secret`; a
 * public client (`token_endpoint_auth_method: "none"`) is issued none and
 * relies on PKCE. Every client is issued a one-time RFC 7592
 * `registration_access_token` and a `registration_client_uri` for later
 * management. Scopes are clamped to the server's configured set, grant types
 * are server-fixed, and a user must still consent before any code is issued.
 */
export function createRegisterHandler(deps: OAuthRegisterDeps) {
  return async function handleRegister(
    ctx: GenericActionCtx<GenericDataModel>,
    request: Request,
  ): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError(400, "invalid_client_metadata", "Request body must be JSON.");
    }

    const validated = validateClientMetadata(body, deps.allowedScopes);
    if (!validated.ok) return validated.response;
    const { name, redirectUris, scopes, tokenEndpointAuthMethod } = validated.value;

    const { clientId, clientSecret, registrationAccessToken } = await deps.createClient(ctx, {
      name,
      redirectUris,
      scopes,
      grantTypes: DCR_GRANT_TYPES,
      tokenEndpointAuthMethod,
    });

    const metadata = clientMetadataBody({
      clientId,
      name,
      redirectUris,
      scopes,
      tokenEndpointAuthMethod,
      registrationClientUri: deps.registrationClientUri(clientId),
    });

    return new Response(
      JSON.stringify({
        ...metadata,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        ...(clientSecret !== undefined
          ? { client_secret: clientSecret, client_secret_expires_at: 0 }
          : {}),
        registration_access_token: registrationAccessToken,
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      },
    );
  };
}
