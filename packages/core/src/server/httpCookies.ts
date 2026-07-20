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

import { parse, serialize } from "cookie";
import { CookieOptions, CookieStore } from "./cookies";

/**
 * Serialize a cookie into a `Set-Cookie` header value.
 *
 * Thin adapter over the `cookie` package's `serialize` that maps our
 * {@link CookieOptions} onto it.
 *
 * Deletion is expressed by the caller as an empty value with `maxAge: 0` (and a
 * past `expires`); see {@link httpCookies}'s `delete`.
 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  return serialize(name, value, {
    path: options.path ?? "/",
    maxAge:
      options.maxAge === undefined ? undefined : Math.floor(options.maxAge),
    expires: options.expires,
    domain: options.domain,
    httpOnly: options.httpOnly,
    secure: options.secure,
    sameSite: options.sameSite,
  });
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
  // `cookie`'s `parse` tolerates malformed percent-encoding on foreign cookies
  // (falling back to the raw value) rather than throwing and failing the whole
  // request.
  const jar = parse(request.headers.get("cookie") ?? "");
  // Reflect writes back to reads within the same request, and remember them as
  // serialized Set-Cookie headers to flush onto the response.
  const overlay = new Map<string, string | null>();
  const pending: string[] = [];
  return {
    get(name) {
      if (overlay.has(name)) return overlay.get(name) ?? undefined;
      return jar[name];
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
