/**
 * Access-token (JWT) inspection helpers for the server layer. These only
 * *decode* the token to read its claims — they never verify the signature
 * (Convex verifies it against the JWKS). Decoding is enough to decide whether a
 * cached access token is still usable or should be refreshed.
 *
 * @module
 */

import { decodeJwt } from "jose";

/** The claims the server cares about from an access token. */
export interface DecodedAccessToken {
  /** Expiry as a UNIX timestamp in seconds, or `null` if absent/unparseable. */
  exp: number | null;
  /** The subject (app user id), or `null` if absent/unparseable. */
  sub: string | null;
}

/**
 * Decode an access token's claims without verifying its signature. Returns
 * nulls if the token is malformed.
 */
export function decodeAccessToken(token: string): DecodedAccessToken {
  try {
    const claims = decodeJwt(token);
    return {
      exp: typeof claims.exp === "number" ? claims.exp : null,
      sub: typeof claims.sub === "string" ? claims.sub : null,
    };
  } catch {
    return { exp: null, sub: null };
  }
}

/**
 * Whether a token is expired or within `skewSeconds` of expiry (so the caller
 * should refresh). A token whose expiry can't be read is treated as expiring.
 */
export function isTokenExpiring(
  token: string,
  skewSeconds = 10,
  nowMs: number = Date.now(),
): boolean {
  const { exp } = decodeAccessToken(token);
  if (exp === null) return true;
  return exp * 1000 - nowMs <= skewSeconds * 1000;
}
