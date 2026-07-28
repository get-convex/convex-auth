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
import type {
  AuthProviderClientSetup,
  MutationCaller,
} from "../browser/providerSetup";
import { AuthClient } from "../browser/sessionManager";
import { TokenStorage, defaultStorage } from "../browser/storage";
import { oauth } from "../oauth/client";
import type { ConvexAuthApi } from "../lib/types";
import {
  AuthProvider,
  ConvexAuthActionsContext,
  ConvexAuthTokenContext,
  useAuth,
} from "./client";

export { useConvexAuth } from "convex/react";
export { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
export type { AuthProviderClientSetup } from "../browser/providerSetup";
export type { TokenStorage } from "../browser/storage";
export type { ConvexAuthApi, TokenBundle } from "../lib/types";
export type { ConvexAuthActionsContextType } from "./client";

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
 *     <ConvexAuthProvider client={convex} api={api.auth}>
 *       {children}
 *     </ConvexAuthProvider>
 *   );
 * }
 * ```
 *
 * OAuth works with no extra setup: sign in with
 * `useSignInWithGoogle(api.auth)` (from `@convex-dev/auth/providers/oauth/react`),
 * which picks the provider's functions off the module you hand it.
 */
export function ConvexAuthProvider({
  client,
  api,
  storage,
  storageNamespace,
  use,
  children,
}: {
  /** Your [`ConvexReactClient`](https://docs.convex.dev/api/classes/react.ConvexReactClient). */
  client: ConvexReactClient;
  /**
   * The core auth mutations, passed as references (usually just `api.auth`).
   * Only `refreshSession` and `signOut` are read here; provider sign-in
   * functions reach their hooks directly (e.g. `useSignInWithGoogle(api.auth)`).
   */
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
  /**
   * Advanced. Provider client setups to register, replacing the default
   * (`[oauth()]`) entirely rather than adding to it — pass `[]` to register
   * nothing, or include `oauth()` yourself to keep it alongside a custom setup.
   * Read once when the client is created and not expected to change.
   */
  use?: AuthProviderClientSetup[];
  children: ReactNode;
}) {
  const { authClient, onMounts } = useMemo(() => {
    // Refresh and sign-out go over a *separate* HTTP client, not the websocket
    // `client`. A refresh happens while `client` is paused waiting for a token,
    // so calling it through `client` would deadlock on the very handshake the
    // refresh is meant to satisfy.
    const httpClient = new ConvexHttpClient(client.url, {
      logger: client.logger,
    });
    const authClient = new AuthClient({
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
    // Provider setups run while the client is constructed, so anything they
    // register in its store exists before the first render reads it. Sign-in
    // mutations are safe on the websocket `client` (it isn't paused pre-auth,
    // unlike the refresh path above). The cast bridges `mutation`'s
    // conditional rest-tuple parameter, which TypeScript can't relate to a
    // plain second argument through an unresolved generic.
    const mutation: MutationCaller = (reference, args) =>
      client.mutation(reference, args as never);
    // Default registration is oauth alone; a provided `use` replaces it
    // entirely (it's an override, not a merge), so an app can opt out of the
    // built-ins or compose its own set.
    const setups = use ?? [oauth()];
    const onMounts = setups.flatMap((setup) => {
      const registration = setup({ client: authClient, mutation });
      return registration?.onMount === undefined ? [] : [registration.onMount];
    });
    return { authClient, onMounts };
    // `client` identity is what matters; the api/storage/use props are read
    // once at construction and are not expected to change.
  }, [client]);

  return (
    <AuthProvider authClient={authClient} onMounts={onMounts}>
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
 * const { setSession, signOut, withSignInPending } = useAuthActions();
 * ```
 *
 * `setSession` adopts a {@link TokenBundle} produced by a provider's sign-in;
 * `signOut` revokes and clears the session; `withSignInPending` reports the
 * auth state as loading while a provider client completes an out-of-band
 * sign-in (e.g. redeeming an OAuth callback code).
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
