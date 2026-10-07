/**
 * Guard for a `ConvexReactClient` created with `expectAuth: true`.
 *
 * Such a client keeps its websocket paused until it holds an auth token, so
 * any function call made through it while the user is signed out never
 * settles. Sign-in is exactly that kind of call. Rather than hang, the
 * providers run those calls through {@link makeGetConvex}, which throws a
 * clear error when it can tell the call would never complete.
 *
 * @module
 */
import type { ConvexReactClient } from "convex/react";

/**
 * Returns a function that hands back `client`, or throws when `client` was
 * created with `expectAuth: true` and the user is signed out.
 *
 * `expectAuth` lives on a private field of the client, so the read is
 * best-effort: if the field moves, the check silently falls back to the old
 * behavior (the call hangs). `getAccessToken` is read at call time, because
 * the auth client it belongs to may not exist yet when this guard is built.
 */
export function makeGetConvex(
  client: ConvexReactClient,
  getAccessToken: () => string | null,
  providerName: string,
): () => ConvexReactClient {
  return () => {
    const expectAuth = (
      client as unknown as { options?: { expectAuth?: boolean } }
    ).options?.expectAuth;
    if (expectAuth === true && getAccessToken() === null) {
      throw new Error(
        `${providerName}: the Convex client was created with ` +
          "`expectAuth: true`, so its connection is paused until the user is " +
          "signed in, and a sign-in call made through it while signed out " +
          "would never complete. Create the client without `expectAuth` to " +
          "sign in. See KNOWN_ISSUES.md.",
      );
    }
    return client;
  };
}
