/**
 * A framework-agnostic {@link CookieStore} over a WHATWG `Request`/`Response`.
 *
 * The shared {@link ServerAuthSession} reads and writes cookies through a
 * {@link CookieStore}. A framework that hands off raw WHATWG requests (a route
 * handler that is `(Request) => Response` — Next.js App Router, Remix, Hono, …)
 * can use {@link httpCookies} to adapt them: it parses the incoming `Cookie`
 * header for reads and buffers writes as `Set-Cookie` headers to apply to the
 * outgoing response.
 *
 * Nothing here depends on React, Next.js, or Convex.
 *
 * @module
 */

import { CookieOptions, CookieStore } from "./cookies";

const SAME_SITE = { lax: "Lax", strict: "Strict", none: "None" } as const;

/**
 * Serialize a cookie into a `Set-Cookie` header value.
 *
 * Deletion is expressed by the caller as an empty value with `maxAge: 0` (and a
 * past `expires`); see {@link httpCookies}'s `delete`.
 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  // Path first among attributes so a delete matches the write's default path.
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  }
  if (options.expires !== undefined) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.domain !== undefined) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite !== undefined) {
    parts.push(`SameSite=${SAME_SITE[options.sameSite]}`);
  }
  return parts.join("; ");
}

/** Parse a request `Cookie` header (`a=1; b=2`) into a name→value map. */
function parseCookieHeader(header: string | null): Map<string, string> {
  const jar = new Map<string, string>();
  if (header === null) return jar;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name === "") continue;
    jar.set(name, decodeURIComponent(pair.slice(eq + 1).trim()));
  }
  return jar;
}

/**
 * A {@link CookieStore} that also knows how to write its buffered mutations onto
 * a response's headers. Build one per request; after driving a
 * {@link ServerAuthSession} with it, call {@link HttpCookies.applyTo} on the
 * response you return.
 */
export interface HttpCookies extends CookieStore {
  /** Append a `Set-Cookie` header for every write/delete made on this store. */
  applyTo: (headers: Headers) => void;
}

/**
 * Adapt an incoming WHATWG {@link Request}'s cookies to a {@link CookieStore}.
 *
 * ```ts
 * const cookies = httpCookies(request);
 * const session = new ServerAuthSession({ authApi, cookies });
 * const bundle = await session.refresh();
 * const res = Response.json({ tokens: bundle && makeSlimBundle(bundle) });
 * cookies.applyTo(res.headers);
 * return res;
 * ```
 */
export function httpCookies(request: Request): HttpCookies {
  const jar = parseCookieHeader(request.headers.get("cookie"));
  // Reflect writes back to reads within the same request, and remember them as
  // serialized Set-Cookie headers to flush onto the response.
  const overlay = new Map<string, string | null>();
  const pending: string[] = [];
  return {
    get(name) {
      if (overlay.has(name)) return overlay.get(name) ?? undefined;
      return jar.get(name);
    },
    set(name, value, options) {
      overlay.set(name, value);
      pending.push(serializeCookie(name, value, options));
    },
    delete(name) {
      overlay.set(name, null);
      pending.push(
        serializeCookie(name, "", {
          path: "/",
          maxAge: 0,
          expires: new Date(0),
        }),
      );
    },
    applyTo(headers) {
      for (const cookie of pending) headers.append("set-cookie", cookie);
    },
  };
}
