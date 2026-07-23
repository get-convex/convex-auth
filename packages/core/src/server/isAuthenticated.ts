/**
 * The framework-agnostic server-side authentication check.
 *
 * It lets SSR hosts answer the question: is this request signed in? {@link
 * createServerAuthChecker} builds a checker that verifies the token against
 * the backend (which checks the signature) before answering.
 *
 * @module
 */

import { ConvexHttpClient } from "convex/browser";
import type { IsAuthenticatedFn } from "../lib/types";
import { isTokenExpiring } from "./jwt";

/** Configuration for {@link createServerAuthChecker}. */
export interface ServerAuthCheckerConfig {
  /** The Convex deployment URL used server-side. */
  convexUrl: string;
  /** The app's `isAuthenticated` query reference. Called with the access token
   * so the backend can verify its signature. */
  isAuthenticated: IsAuthenticatedFn;
}

/** Reports whether a JWT `accessToken` is a valid, signed-in session (`null` =
 * no token = not signed in). */
export type ServerAuthChecker = (
  accessToken: string | null,
) => Promise<boolean>;

/**
 * Build a {@link ServerAuthChecker} that verifies a JWT access token against
 * the backend.
 *
 * The returned checker treats an absent or already-expired token as
 * unauthenticated without a round trip (a cheap local gate); otherwise it asks
 * the backend, which verifies the token's signature. Any error (network,
 * rejected token) fails closed to `false`.
 */
export function createServerAuthChecker(
  config: ServerAuthCheckerConfig,
): ServerAuthChecker {
  return async (accessToken) => {
    // Cheap local gate: an absent or already-expired token needs no round trip.
    if (accessToken === null || isTokenExpiring(accessToken, 0)) return false;

    const client = new ConvexHttpClient(config.convexUrl);
    client.setAuth(accessToken);
    try {
      return await client.query(config.isAuthenticated, {});
    } catch {
      return false;
    }
  };
}
