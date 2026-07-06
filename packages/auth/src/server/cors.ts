/**
 * CORS for the auth HTTP surface, as a single policy module with two modes.
 *
 * - **Permissive-bearer** ({@link corsHeaders}, {@link withCors}): the public
 *   authorization-server, discovery, and MCP endpoints are reached cross-origin
 *   by browser-based OAuth/MCP clients (e.g. a web agent discovering the server
 *   and exchanging tokens). They are bearer-token endpoints (no cookies), so
 *   `Access-Control-Allow-Origin: *` is safe.
 * - **Origin-matched** ({@link buildCorsHeaders}, {@link corsPreflightResponse}):
 *   the `Authorization: Bearer sk_*` API-key surface (`auth.request.action` /
 *   `auth.request.route`) matches the request `Origin` against an allow-list and
 *   denies by default when it doesn't match.
 *
 * @module
 */

import { httpActionGeneric, type HttpRouter } from "convex/server";

import type { CorsConfig } from "./types";

const ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOW_HEADERS = "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version";
const DEFAULT_MATCHED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const DEFAULT_MATCHED_HEADERS = "Content-Type,Authorization";

/** CORS response headers for the public bearer OAuth/MCP surface (`*` origin). */
export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": ALLOW_METHODS,
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Max-Age": "86400",
  };
}

/** Copy `response`, adding permissive-bearer CORS headers. */
export function withCorsResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Wrap a raw `(ctx, request) => Response` handler so its responses carry
 * permissive-bearer CORS headers. Generic over the ctx type so it composes with
 * both `httpActionGeneric` and a deployment's specific `httpAction`.
 */
export function withCors<Ctx>(
  handler: (ctx: Ctx, request: Request) => Promise<Response>,
): (ctx: Ctx, request: Request) => Promise<Response> {
  return async (ctx, request) => withCorsResponse(await handler(ctx, request));
}

/** Shared `OPTIONS` preflight handler for the bearer surface: `204` + CORS headers. */
export const corsPreflightHandler = httpActionGeneric(
  async () => new Response(null, { status: 204, headers: corsHeaders() }),
);

/** Register an `OPTIONS` preflight route for each distinct path (deduped). */
export function registerCorsPreflight(http: HttpRouter, paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    http.route({ path, method: "OPTIONS", handler: corsPreflightHandler });
  }
}

/**
 * Build origin-matched CORS headers by matching the request `Origin` against
 * `corsConfig.origins` (falling back to `defaultOrigins`, the site URLs). When
 * the origin does not match and `*` is not allowed, no `Access-Control-Allow-Origin`
 * header is emitted — a deny-by-default credentialed policy.
 */
export function buildCorsHeaders(
  request: Request,
  corsConfig: CorsConfig | undefined,
  defaultOrigins: string[] | (() => string[]),
): Record<string, string> {
  const origins =
    corsConfig?.origins ??
    (typeof defaultOrigins === "function" ? defaultOrigins() : defaultOrigins);
  const requestOrigin = request.headers.get("Origin");
  const matchedOrigin = origins.includes("*")
    ? "*"
    : requestOrigin && origins.includes(requestOrigin)
      ? requestOrigin
      : null;

  return {
    ...(matchedOrigin ? { "Access-Control-Allow-Origin": matchedOrigin } : {}),
    "Access-Control-Allow-Methods": corsConfig?.methods ?? DEFAULT_MATCHED_METHODS,
    "Access-Control-Allow-Headers": corsConfig?.headers ?? DEFAULT_MATCHED_HEADERS,
  };
}

/** Build the `204` origin-matched preflight response for the API-key surface. */
export function corsPreflightResponse(
  request: Request,
  corsConfig: CorsConfig | undefined,
  defaultOrigins: string[] | (() => string[]),
): Response {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(request, corsConfig, defaultOrigins),
  });
}
