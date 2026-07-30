/**
 * Client bindings for Convex Auth on Next.js (App Router), exported at
 * `@convex-dev/auth/nextjs`.
 *
 * When running under SSR, authentication is performed for two parties:
 *
 *  1. The Convex client (for all of the reactive/transactional client-side
 *     goodness)
 *  2. The browser itself (for authenticated requests to the SSR host)
 *
 * Under SSR the refresh token lives only in a server-only httpOnly cookie, so
 * client JS can only read the access token. {@link ConvexAuthNextjsProvider}
 * configures the core {@link AuthClient} in that mode: it refreshes and signs
 * out by POSTing to the SSR host's auth routes (which read the cookie) rather
 * than talking to Convex directly.
 *
 * Sign-in likewise runs on the server. A provider's SSR sibling hook (e.g.
 * {@link useAnonymousAuth}) POSTs to that provider's sign-in route mounted on
 * the SSR host; the handler there mints the session, stashes the refresh token
 * in the cookie, and returns a {@link SlimTokenBundle} which only contains the
 * access token (for the client to authenticate to the Convex backend).
 *
 * @module
 */
"use client";

import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ReactNode, useCallback, useMemo, useState } from "react";
import { AuthClient } from "../browser/sessionManager";
import { TokenStorage, defaultStorage } from "../browser/storage";
import { ANONYMOUS_SIGN_IN_PATH } from "../components/anonymous/routes";
import type { Credentials } from "../components/password/react";
import {
  PASSWORD_SIGN_IN_PATH,
  PASSWORD_SIGN_UP_PATH,
} from "../components/password/routes";
import type { SignInResult, SignUpResult } from "../components/password/setup";
import { AUTH_BASE_PATH, REFRESH_PATH, SIGN_OUT_PATH } from "../lib/routes";
import type { SlimTokenBundle } from "../lib/types";
import { useAuthActions } from "../react";
import { AuthProvider, useAuth } from "../react/client";

export { useConvexAuth } from "convex/react";
export { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
export { useAuthActions, useAuthToken } from "../react";

/**
 * POST JSON to an auth route and read back the result: the access-only tokens
 * on success, or `tokens: null` with the provider's `userError`, if it gave
 * one, on failure.
 *
 * The auth routes reply with the same JSON shape on failure as on success — a
 * failed sign-in or refresh is a 401 carrying `{ tokens: null }` plus any
 * provider `userError` — so parse the body regardless of status. Anything
 * without a JSON body (a proxy 5xx, a network-level error page) degrades to
 * `{ tokens: null }`; network errors propagate to the caller.
 */
async function postAuth(
  route: string,
  body: Record<string, unknown>,
): Promise<{ tokens: SlimTokenBundle | null; userError?: unknown }> {
  const res = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json().catch(() => ({ tokens: null }))) as {
    tokens: SlimTokenBundle | null;
    userError?: unknown;
  };
}

/**
 * Wrap your app in this (in a Client Component, typically rendered by the
 * server-side `ConvexAuthNextjsServerProvider`) to enable authentication under
 * SSR.
 *
 * It holds the {@link ConvexReactClient} and wraps it with {@link
 * ConvexProviderWithAuth} so it is properly configured for the SSR auth
 * environment.
 */
export function ConvexAuthNextjsProvider({
  client,
  convexUrl,
  initialToken = null,
  refreshRoute = `${AUTH_BASE_PATH}/${REFRESH_PATH}`,
  signOutRoute = `${AUTH_BASE_PATH}/${SIGN_OUT_PATH}`,
  storage,
  children,
}: {
  /** An existing `ConvexReactClient`. If omitted, one is created from
   * `convexUrl` (or `NEXT_PUBLIC_CONVEX_URL`). */
  client?: ConvexReactClient;
  /** The Convex deployment URL. Defaults to `NEXT_PUBLIC_CONVEX_URL`. */
  convexUrl?: string;
  /** The access token from SSR host, if available, so the Convex client
   * hydrates ready to authenticate. */
  initialToken?: string | null;
  /** Route that refreshes the access token from the httpOnly cookie. */
  refreshRoute?: string;
  /** Route that revokes the session and clears cookies. */
  signOutRoute?: string;
  /** A custom {@link TokenStorage}. Defaults to `localStorage` in the browser.
   * Under SSR, it only stores the access token. */
  storage?: TokenStorage;
  children: ReactNode;
}) {
  const { authClient, convex } = useMemo(() => {
    const convex =
      client ??
      new ConvexReactClient(convexUrl ?? process.env.NEXT_PUBLIC_CONVEX_URL!);
    const authClient = new AuthClient({
      mode: "ssr",
      authApi: {
        // The refresh token is read from the httpOnly cookie when it reaches the SSR host.
        refreshSession: async () => (await postAuth(refreshRoute, {})).tokens,
        signOut: async () => {
          await postAuth(signOutRoute, {});
        },
      },
      storage: storage ?? defaultStorage(),
      storageNamespace: convex.url,
      // The SSR host may have refreshed on our behalf, so this is the freshest
      // access token; the client adopts it on init.
      initialAccessToken: initialToken,
    });
    return { authClient, convex };
    // `client`/`convexUrl` identity is what matters; other props are read once.
  }, [client, convexUrl]);

  return (
    <AuthProvider authClient={authClient}>
      <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthProvider>
  );
}

/**
 * SSR sibling of the anonymous provider's client-direct
 * `useAnonymousAuth` (`@convex-dev/auth/providers/anonymous/react`).
 *
 * Sign-in runs on the SSR host: this POSTs to the anonymous sign-in route (where
 * the `anonymous` provider is mounted via `signInHandler`), and adopts the
 * access-only session it returns.
 *
 * ```tsx
 * const { signInAnonymous } = useAnonymousAuth();
 * <button onClick={() => signInAnonymous()}>Sign in anonymously</button>;
 * ```
 */
export function useAnonymousAuth(options?: { route?: string }) {
  const { setSession } = useAuthActions();
  const route = options?.route ?? `${AUTH_BASE_PATH}/${ANONYMOUS_SIGN_IN_PATH}`;
  const signInAnonymous = useCallback(async () => {
    const { tokens } = await postAuth(route, {});
    if (tokens) await setSession(tokens);
  }, [setSession, route]);
  return { signInAnonymous };
}

/** The password provider's failure arm for a given flow's result. */
type PasswordFailure<Result> = Extract<Result, { success: false }>;

/**
 * A failure the client produces that the server never returns: the POST to the
 * sign-in route threw or came back with neither tokens nor a `userError`.
 * Folding it into the result as `OTHER_ERROR` keeps every failure on the one
 * `userError` switch, exactly like the client-direct password hooks.
 */
type UnexpectedFailure = {
  success: false;
  userError: { error: "OTHER_ERROR"; cause: unknown };
};

/**
 * The result of the `signIn` callback from {@link useSignInWithPassword}.
 *
 * Unlike the client-direct result, success carries no tokens: under SSR the
 * refresh token stays in the httpOnly cookie and the hook has already adopted
 * the access-only session.
 */
export type SignInWithPasswordResult =
  { success: true } | PasswordFailure<SignInResult> | UnexpectedFailure;

/** The result of the `signUp` callback from {@link useSignUpWithPassword}. */
export type SignUpWithPasswordResult =
  { success: true } | PasswordFailure<SignUpResult> | UnexpectedFailure;

/**
 * Shared internals for the two password flows: POST the credentials to the
 * flow's route, adopt the access-only session on success, and surface the
 * route's `userError` (or fold an unexpected failure into `OTHER_ERROR`).
 */
function usePasswordRoute<Failure extends { success: false }>(route: string) {
  const { setSession } = useAuthActions();
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (
      credentials: Credentials,
    ): Promise<{ success: true } | Failure | UnexpectedFailure> => {
      setPending(true);
      try {
        const { tokens, userError } = await postAuth(route, credentials);
        if (tokens) {
          await setSession(tokens);
          return { success: true };
        }
        if (userError !== undefined) {
          // The route echoes the password action's `userError` verbatim; the
          // cast trusts that `route` mounts the matching password handler.
          return { success: false, userError } as unknown as Failure;
        }
        return {
          success: false,
          userError: {
            error: "OTHER_ERROR",
            cause: new Error(
              `sign-in route ${route} returned neither tokens nor a userError`,
            ),
          },
        };
      } catch (cause) {
        return { success: false, userError: { error: "OTHER_ERROR", cause } };
      } finally {
        setPending(false);
      }
    },
    [route, setSession],
  );

  return { run, pending };
}

/**
 * SSR sibling of the password provider's client-direct `useSignInWithPassword`
 * (`@convex-dev/auth/providers/password/react`).
 *
 * Sign-in runs on the SSR host: this POSTs the credentials to the password
 * sign-in route (where the `passwordSignIn` descriptor is mounted via
 * `signInHandler`) and adopts the access-only session it returns. The result
 * mirrors the client-direct hook's, so error-mapping UI ports over unchanged —
 * except that success carries no tokens.
 *
 * Upon a successful sign-in, client code should redirect to the desired
 * authentication protected route.
 *
 * ```tsx
 * const { signIn, pending } = useSignInWithPassword();
 * const result = await signIn({ username, password });
 * if (!result.success) {
 *   // map result.userError to a message
 * }
 * // redirect to a signed in route destionation
 * ```
 */
export function useSignInWithPassword(options?: { route?: string }) {
  const { run, pending } = usePasswordRoute<PasswordFailure<SignInResult>>(
    options?.route ?? `${AUTH_BASE_PATH}/${PASSWORD_SIGN_IN_PATH}`,
  );
  return {
    /** POST the credentials to the sign-in route; see {@link SignInWithPasswordResult}. */
    signIn: run,
    /** `true` while the sign-in attempt is being validated. */
    pending,
  };
}

/**
 * SSR sibling of the password provider's client-direct `useSignUpWithPassword`
 * (`@convex-dev/auth/providers/password/react`); the sign-up counterpart of
 * {@link useSignInWithPassword}, POSTing to the `passwordSignUp` route.
 *
 * Upon a successful sign-up, client code should redirect to the desired
 * authentication protected route.
 */
export function useSignUpWithPassword(options?: { route?: string }) {
  const { run, pending } = usePasswordRoute<PasswordFailure<SignUpResult>>(
    options?.route ?? `${AUTH_BASE_PATH}/${PASSWORD_SIGN_UP_PATH}`,
  );
  return {
    /** POST the credentials to the sign-up route; see {@link SignUpWithPasswordResult}. */
    signUp: run,
    /** `true` while the sign-up attempt is being validated. */
    pending,
  };
}
