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
  return untrustedOriginReason(request, allowedOrigins) === null;
}

/**
 * Why {@link isTrustedOrigin} refuses a request, as a message for logs and
 * error responses, or `null` if it trusts it.
 */
export function untrustedOriginReason(
  request: Request,
  allowedOrigins: string[] = [],
): string | null {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") {
    return (
      "Cross-site request refused: the request has no Origin header. " +
      "Browsers send one with every POST; a script has to set it to the " +
      "app's own origin."
    );
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return `Cross-site request refused: the Origin header ${origin} is not a valid origin.`;
  }
  const host = request.headers.get("host");
  if (originHost === host) return null;
  if (allowedOrigins.some((allowed) => hostOf(allowed) === originHost)) {
    return null;
  }
  return (
    `Cross-site request refused: Origin ${origin} does not match ` +
    `Host ${host ?? "(missing)"}. If the app runs behind a proxy that ` +
    "rewrites Host, add its public origin to `allowedOrigins`."
  );
}

/**
 * The uniform reply of the refresh and sign-out handlers for a refused
 * cross-site request: 403, an {@link AuthSessionResponse} carrying
 * `tokens: null`, and no cookie headers. Logs the reason, since the body
 * doesn't carry it.
 */
export function forbiddenOriginResponse(reason: string): Response {
  console.warn(`Convex Auth: ${reason}`);
  return Response.json({ tokens: null } satisfies AuthSessionResponse, {
    status: 403,
  });
}
