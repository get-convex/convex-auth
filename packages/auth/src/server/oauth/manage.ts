import type { GenericActionCtx, GenericDataModel } from "convex/server";

import { extractBearerToken } from "../utils/bearer";
import type { OAuthClientDoc, OAuthClientUpdate, OAuthTokenEndpointAuthMethod } from "./client";
import { clientMetadataBody, jsonError, validateClientMetadata } from "./register";

/**
 * RFC 7592 `401` challenge for a missing/invalid registration access token.
 * Carries `WWW-Authenticate: Bearer` (the endpoint authenticates with a bearer
 * `registration_access_token`) atop the shared `no-store` error body.
 */
function unauthorizedError(description: string): Response {
  const base = jsonError(401, "invalid_token", description);
  const headers = new Headers(base.headers);
  headers.set("WWW-Authenticate", 'Bearer realm="registration", error="invalid_token"');
  return new Response(base.body, { status: 401, headers });
}

/** Dependencies injected by the runtime into the RFC 7592 management handler. */
export interface OAuthManageDeps {
  /** Verify a registration access token against the path client (constant-time). */
  verifyRegistrationToken: (
    ctx: GenericActionCtx<GenericDataModel>,
    args: { clientId: string; token: string },
  ) => Promise<OAuthClientDoc | null>;
  /** Apply a validated metadata patch to the client. */
  update: (
    ctx: GenericActionCtx<GenericDataModel>,
    args: { clientId: string; patch: OAuthClientUpdate },
  ) => Promise<void>;
  /** Soft-revoke (deregister) the client. */
  revoke: (ctx: GenericActionCtx<GenericDataModel>, args: { clientId: string }) => Promise<unknown>;
  /** Scopes the server is willing to grant; `PUT` clamps requested scopes to this. */
  allowedScopes: string[];
  /** Build the `registration_client_uri` for the managed client. */
  registrationClientUri: (clientId: string) => string;
}

/** The client's effective auth method, falling back for un-backfilled rows. */
function effectiveMethod(client: OAuthClientDoc): OAuthTokenEndpointAuthMethod {
  return (
    client.tokenEndpointAuthMethod ?? (client.clientSecretHash ? "client_secret_post" : "none")
  );
}

/**
 * Pull the trailing `<client_id>` segment from a `.../oauth2/register/<id>`
 * path. Returns `null` for any deeper or differently-shaped path so the
 * `pathPrefix` route only ever serves the exact one-segment management URL.
 */
function clientIdFromPath(request: Request): string | null {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  const prev = segments[segments.length - 2];
  if (prev !== "register" || last === undefined) return null;
  return decodeURIComponent(last);
}

function metadataResponse(
  client: OAuthClientDoc,
  deps: OAuthManageDeps,
  method: OAuthTokenEndpointAuthMethod,
): Response {
  const body = clientMetadataBody({
    clientId: client.clientId,
    name: client.name,
    redirectUris: client.redirectUris,
    scopes: client.scopes,
    tokenEndpointAuthMethod: method,
    registrationClientUri: deps.registrationClientUri(client.clientId),
  });
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function handlePut(
  ctx: GenericActionCtx<GenericDataModel>,
  request: Request,
  deps: OAuthManageDeps,
  client: OAuthClientDoc,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "invalid_client_metadata", "Request body must be JSON.");
  }
  if (typeof body.client_id === "string" && body.client_id !== client.clientId) {
    return jsonError(400, "invalid_client_metadata", "client_id is immutable.");
  }

  const validated = validateClientMetadata(body, deps.allowedScopes);
  if (!validated.ok) return validated.response;
  const { name, redirectUris, scopes, tokenEndpointAuthMethod } = validated.value;

  if (effectiveMethod(client) === "none" && tokenEndpointAuthMethod !== "none") {
    return jsonError(
      400,
      "invalid_client_metadata",
      "Cannot upgrade a public client to confidential; register a new client instead.",
    );
  }

  await deps.update(ctx, {
    clientId: client.clientId,
    patch: { name, redirectUris, scopes, tokenEndpointAuthMethod },
  });
  return metadataResponse(
    {
      ...client,
      name,
      redirectUris,
      scopes,
      tokenEndpointAuthMethod,
      clientSecretHash: tokenEndpointAuthMethod === "none" ? undefined : client.clientSecretHash,
    },
    deps,
    tokenEndpointAuthMethod,
  );
}

/**
 * RFC 7592 Dynamic Client Configuration handler: `GET`/`PUT`/`DELETE` of a
 * registered client at `.../oauth2/register/<client_id>`, authenticated by the
 * `registration_access_token` issued at registration.
 *
 * The token is verified against the client named in the path (constant-time
 * hash compare), so a token issued for one client can never read, modify, or
 * delete another. `PUT` replaces mutable metadata, re-running the same
 * validation as registration (redirect-uri rules, scope clamping) so a client
 * cannot escalate its own scopes or redirect URIs; it may downgrade to a public
 * client but not silently upgrade to confidential. `DELETE` soft-revokes the
 * client — its outstanding refresh/code exchanges are then rejected, though any
 * already-issued access token remains valid until it expires.
 *
 * @see https://www.rfc-editor.org/rfc/rfc7592
 */
export function createClientManagementHandler(deps: OAuthManageDeps) {
  return async function handleManage(
    ctx: GenericActionCtx<GenericDataModel>,
    request: Request,
  ): Promise<Response> {
    const clientId = clientIdFromPath(request);
    if (clientId === null) {
      return jsonError(404, "invalid_request", "Unknown registration endpoint.");
    }
    const token = extractBearerToken(request);
    if (token === null) {
      return unauthorizedError("Registration access token required.");
    }
    const client = await deps.verifyRegistrationToken(ctx, { clientId, token });
    if (client === null) {
      return unauthorizedError("Invalid registration access token.");
    }

    switch (request.method) {
      case "GET":
        return metadataResponse(client, deps, effectiveMethod(client));
      case "PUT":
        return handlePut(ctx, request, deps, client);
      case "DELETE":
        await deps.revoke(ctx, { clientId });
        return new Response(null, { status: 204 });
      default:
        return jsonError(405, "invalid_request", "Method not allowed.");
    }
  };
}
