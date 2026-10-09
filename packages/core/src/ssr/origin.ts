/**
 * CSRF protection for the auth handlers, by checking the `Origin` header.
 *
 * Every auth route is a state-changing POST whose effect rides on cookies:
 * sign-in writes the session cookies, refresh rotates them, sign-out clears
 * them. The cookies have the `SameSite=lax` attribute but that only prevents
 * previously set cookies from being sent in a cross-site request.
 *
 * This code checks that requests originate from allowed origins (the current
 * `Host` or specifically `allowedOrigins`). See
 * https://auth.pilcrowonpaper.com/csrf).
 *
 * Browsers attach an `Origin` header to every cross-site POST, so the rule
 * is: a request whose `Origin` matches neither the `Host` header it arrived
 * at nor a configured allowed origin is refused, before any Convex call runs
 * or cookie is written.
 *
 * @module
 */

import type { AuthSessionResponse } from "../lib/types.ts";

/**
 * Extracts just the host portion from an `origin`.
 *
 * Handles `origin` URLs but also allows bare hosts (passing them through).
 */
function hostOf(origin: string): string {
  if (!origin.includes("://")) {
    return origin;
  }
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * Whether a request may be served by a state-changing auth handler.
 *
 * Trusts a request when its `Origin` header matches the `Host` header it
 * arrived at or one of
 * `allowedOrigins` (for deployments where the two legitimately differ, e.g. a
 * proxy that rewrites `Host`). Entries may be full origins
 * (`"https://app.example.com"`) or bare hosts (`"app.example.com"`,
 * `"localhost:3000"`).
 */
export function isTrustedOrigin(
  request: Request,
  allowedOrigins: string[] = [],
): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (originHost === request.headers.get("host")) return true;
  return allowedOrigins.some((allowed) => hostOf(allowed) === originHost);
}

/**
 * The uniform reply for a refused cross-site request: 403, an
 * {@link AuthSessionResponse} carrying `tokens: null`, and no cookie headers.
 */
export function forbiddenOriginResponse(): Response {
  return Response.json({ tokens: null } satisfies AuthSessionResponse, {
    status: 403,
  });
}
