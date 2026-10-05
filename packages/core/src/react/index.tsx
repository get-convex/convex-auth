/**
 * React bindings for Convex Auth.
 *
 * Build the auth client once with {@link createAuthClient}, outside React, and
 * wrap your app in {@link ConvexAuthProvider} in place of `ConvexProvider`.
 * The auth client stores the session, refreshes the access token, and signs
 * out. The provider passes its state to Convex's `ConvexProviderWithAuth`.
 *
 * ```tsx
 * import { ConvexAuthProvider, createAuthClient } from "@convex-dev/auth/react";
 * import { ConvexReactClient } from "convex/react";
 * import { api } from "../convex/_generated/api";
 *
 * const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);
 * const auth = createAuthClient({
 *   url: import.meta.env.VITE_CONVEX_URL,
 *   api: api.auth,
 * });
 *
 * function Root({ children }: { children: React.ReactNode }) {
 *   return (
 *     <ConvexAuthProvider client={convex} auth={auth}>
 *       {children}
 *     </ConvexAuthProvider>
 *   );
 * }
 * ```
 *
 * Each auth provider (password, OAuth, passkey, and others) ships its own
 * hooks. They run the provider's sign-in function and pass the resulting
 * {@link TokenBundle} to the auth client's `setSession`.
 *
 * @module
 */
"use client";

import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ReactNode, useContext, useEffect, useMemo } from "react";
import type { AuthClient } from "../browser/sessionManager.ts";
import type { AuthSignInApi } from "../browser/signInApi.ts";
import {
  AuthProvider,
  ConvexAuthActionsContext,
  ConvexAuthTokenContext,
  useAuth,
} from "./client.tsx";

export { useConvexAuth } from "convex/react";
export { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
export {
  createAuthClient,
  type CreateAuthClientOptions,
} from "../browser/createAuthClient.ts";
export type { AuthClient, AuthState } from "../browser/sessionManager.ts";
export type { TokenStorage } from "../browser/storage.ts";
export type { ConvexAuthApi, TokenBundle } from "../lib/types.ts";
export type { ConvexAuthActionsContextType } from "./client.tsx";
export { useAuthClient, type AuthSignInApi } from "./client.tsx";

/**
 * Replace your `ConvexProvider` with this to enable authentication. See the
 * module docs for an example.
 */
export function ConvexAuthProvider({
  client,
  auth,
  children,
}: {
  /** Your [`ConvexReactClient`](https://docs.convex.dev/api/classes/react.ConvexReactClient). */
  client: ConvexReactClient;
  /** The auth client from {@link createAuthClient}. */
  auth: AuthClient;
  children: ReactNode;
}) {
  const signInApi = useMemo<AuthSignInApi>(
    () => ({
      mutation: (fn, args) => client.mutation(fn, args),
      action: (fn, args) => client.action(fn, args),
    }),
    [client],
  );
  // Set during render, because the mount effects of child components call
  // auth.signIn before the effects of this component run.
  auth.setSignInApi(signInApi);

  // Under expectAuth the Convex client pauses its websocket until setAuth
  // runs, and a signed-out user sends the sign-in mutation over that socket.
  useEffect(() => {
    let settled = false;
    const listener = () => {
      const { isLoading, isAuthenticated } = auth.getSnapshot();
      if (settled || isLoading) return;
      settled = true;
      unsubscribe();
      if (!isAuthenticated) {
        client.setAuth(auth.fetchAccessToken, () => {});
      }
    };
    const unsubscribe = auth.subscribe(listener);
    listener();
    return unsubscribe;
  }, [auth, client]);

  return (
    <AuthProvider authClient={auth}>
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
 * - `setSession` adopts a {@link TokenBundle} produced by a provider's
 *   sign-in.
 * - `signOut` revokes and clears the session.
 *
 * Provider code reads the whole client with {@link useAuthClient}.
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
