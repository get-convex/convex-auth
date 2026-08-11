/**
 * React bindings for Convex Auth.
 *
 * Wrap your app in {@link ConvexAuthProvider} (in place of `ConvexProvider`) to
 * enable authentication. The provider owns the token lifecycle — storing the
 * session, refreshing the access token, signing out — and feeds Convex's
 * `ConvexProviderWithAuth` a `useAuth` hook.
 *
 * Authentication methods are deliberately not part of this core: each auth provider
 * (password, OAuth, passkey, …) ships its own authentication API that returns a
 * {@link TokenBundle}. Hand that bundle to {@link useAuthActions}'s `setSession`
 * which allows the Convex client to authenticate with the backend.
 *
 * @module
 */
"use client";

import { ConvexHttpClient } from "convex/browser";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ReactNode, useContext, useMemo } from "react";
import { AuthClient } from "../browser/sessionManager";
import { TokenStorage, defaultStorage } from "../browser/storage";
import type { ConvexAuthApi } from "../lib/types";
import {
  AuthProvider,
  ConvexAuthActionsContext,
  ConvexAuthTokenContext,
  useAuth,
  type AuthSignInApi,
} from "./client";

export { useConvexAuth } from "convex/react";
export { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
export type { TokenStorage } from "../browser/storage";
export type { ConvexAuthApi, TokenBundle } from "../lib/types";
export type { ConvexAuthActionsContextType } from "./client";
export { useAuthSignInApi, type AuthSignInApi } from "./client";

/**
 * Replace your `ConvexProvider` with this to enable authentication.
 *
 * ```tsx
 * import { ConvexAuthProvider } from "@convex-dev/auth/react";
 * import { ConvexReactClient } from "convex/react";
 * import { api } from "../convex/_generated/api";
 *
 * const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);
 *
 * function Root({ children }: { children: React.ReactNode }) {
 *   return (
 *     <ConvexAuthProvider
 *       client={convex}
 *       api={{ refreshSession: api.auth.refreshSession, signOut: api.auth.signOut }}
 *     >
 *       {children}
 *     </ConvexAuthProvider>
 *   );
 * }
 * ```
 */
export function ConvexAuthProvider({
  client,
  api,
  storage,
  storageNamespace,
  children,
}: {
  /** Your [`ConvexReactClient`](https://docs.convex.dev/api/classes/react.ConvexReactClient). */
  client: ConvexReactClient;
  /** The app's `refreshSession` and `signOut` mutation references. */
  api: ConvexAuthApi;
  /**
   * A custom {@link TokenStorage}. Defaults to `localStorage` in the browser
   * (in-memory under SSR). Set this for React Native, or to `sessionStorage`
   * for per-tab sessions.
   */
  storage?: TokenStorage;
  /**
   * Namespace for storage keys, which determines whether tokens are shared.
   * Non-alphanumeric characters are ignored. Defaults to the deployment URL.
   */
  storageNamespace?: string;
  children: ReactNode;
}) {
  const authClient = useMemo(() => {
    // Refresh and sign-out go over a *separate* HTTP client, not the websocket
    // `client`. A refresh happens while `client` is paused waiting for a token,
    // so calling it through `client` would deadlock on the very handshake the
    // refresh is meant to satisfy.
    const httpClient = new ConvexHttpClient(client.url, {
      logger: client.logger,
    });
    return new AuthClient({
      mode: "spa",
      authApi: {
        refreshSession: (refreshToken) =>
          httpClient.mutation(api.refreshSession, { refreshToken }),
        signOut: async (refreshToken) => {
          await httpClient.mutation(api.signOut, { refreshToken });
        },
      },
      storage: storage ?? defaultStorage(),
      storageNamespace: storageNamespace ?? client.url,
    });
    // `client` identity is what matters; the api/storage props are read once at
    // construction and are not expected to change.
  }, [client]);

  // Sign-in functions run against the deployment over the same websocket client
  // as the rest of the app, so the response carries the full token bundle for
  // `setSession` to persist.
  const signInApi = useMemo<AuthSignInApi>(
    () => ({
      mutation: (fn, args) => client.mutation(fn, args),
      action: (fn, args) => client.action(fn, args),
    }),
    [client],
  );

  return (
    <AuthProvider authClient={authClient} signInApi={signInApi}>
      <ConvexProviderWithAuth client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthProvider>
  );
}

/**
 * Access the auth actions:
 *
 * ```ts
 * const { setSession, signOut } = useAuthActions();
 * ```
 *
 * `setSession` adopts a {@link TokenBundle} produced by a provider's sign-in;
 * `signOut` revokes and clears the session.
 */
export function useAuthActions() {
  const actions = useContext(ConvexAuthActionsContext);
  if (actions === undefined) {
    throw new Error(
      "useAuthActions must be used within a <ConvexAuthProvider>.",
    );
  }
  return actions;
}

/**
 * The current access token (a JWT), or null when signed out.
 *
 * Use it to authenticate requests to your Convex HTTP actions
 * (`Authorization: Bearer <token>`). Treat it as an ID token — do not send it
 * to other servers.
 */
export function useAuthToken() {
  return useContext(ConvexAuthTokenContext);
}
