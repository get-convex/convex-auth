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
import { ReactNode, useCallback, useContext, useMemo, useState } from "react";
import type {
  AmbientSignInClient,
  AuthSignInApi,
} from "../browser/ambientSignInClient.ts";
import { AuthClient } from "../browser/sessionManager.ts";
import { TokenStorage, defaultStorage } from "../browser/storage.ts";
import { oauth } from "../oauth/client.ts";
import type {
  ClientView,
  ContinueSignInFn,
  ContinueSignInResult,
  ConvexAuthApi,
} from "../lib/types.ts";
import {
  AuthProvider,
  ConvexAuthActionsContext,
  ConvexAuthTokenContext,
  useAuth,
  useAuthSignInApi,
} from "./client.tsx";

export { useConvexAuth } from "convex/react";
export { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
export type { AmbientSignInClient } from "../browser/ambientSignInClient.ts";
export type { TokenStorage } from "../browser/storage.ts";
export type {
  ContinueSignInFn,
  ContinueSignInResult,
  ConvexAuthApi,
  TokenBundle,
} from "../lib/types.ts";
export type { ConvexAuthActionsContextType } from "./client.tsx";
export { useAuthSignInApi, type AuthSignInApi } from "./client.tsx";

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
  ambientSignIns,
  children,
}: {
  /** Your [`ConvexReactClient`](https://docs.convex.dev/api/classes/react.ConvexReactClient). */
  client: ConvexReactClient;
  /** The app's `refreshSession` and `signOut` mutation references. */
  api: ConvexAuthApi;
  /**
   * A custom {@link TokenStorage} implementation.
   *
   * If none is supplied, the system defaults to `localStorage` in the browser
   * and in-memory where there is no `localStorage` (SSR).
   *
   * Client runtimes with no `localStorage` like React Native are strongly
   * advised to provide an implementation, because the in-memory default will
   * cause users to get logged out each time the app closes.
   *
   * Here's an example of an implementation for Expo that could be passed in
   * here:
   *
   * ```ts
   * import * as SecureStore from "expo-secure-store";
   *
   * const secureStorage = {
   *   getItem: SecureStore.getItemAsync,
   *   setItem: SecureStore.setItemAsync,
   *   removeItem: SecureStore.deleteItemAsync,
   * };
   * ```
   */
  storage?: TokenStorage;
  /**
   * Namespace for storage keys, which determines whether tokens are shared.
   * Non-alphanumeric characters are ignored. Defaults to the deployment URL.
   */
  storageNamespace?: string;
  /**
   * Advanced. Ambient sign-ins run initialization for auth providers that can
   * take action outside of a user activated sign in flow, such as reading an
   * oauth code from a url query param.
   *
   * Setting this replaces the default (`[oauth()]`) entirely rather than adding
   * to it. Pass `[]` to register nothing, or include `oauth()` (from
   * `@convex-dev/auth/providers/oauth/react`) yourself to keep it alongside
   * other sign-ins. Read once when the client is created and not expected to
   * change.
   */
  ambientSignIns?: AmbientSignInClient[];
  children: ReactNode;
}) {
  const { authClient, signInApi } = useMemo(() => {
    // Refresh and sign-out go over a *separate* HTTP client, not the websocket
    // `client`. A refresh happens while `client` is paused waiting for a token,
    // so calling it through `client` would deadlock on the very handshake the
    // refresh is meant to satisfy.
    const httpClient = new ConvexHttpClient(client.url, {
      logger: client.logger,
    });
    // Sign-in functions run against the deployment over the same websocket
    // client as the rest of the app (it isn't paused pre-auth, unlike the
    // refresh path below), so the response carries the full token bundle for
    // `setSession` to persist. The same object serves provider setups here
    // and, via AuthProvider below, provider hooks.
    const signInApi: AuthSignInApi = {
      mutation: (fn, args) => client.mutation(fn, args),
      action: (fn, args) => client.action(fn, args),
    };
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
      ambientSignIns: { signIns: ambientSignIns ?? [oauth()], signInApi },
    });
    return { authClient, signInApi };
    // `client` identity is what matters. The other props are read once at
    // construction and are not expected to change.
  }, [client]);

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
 * - `setSession` adopts a {@link TokenBundle} produced by a provider's
 *   sign-in.
 * - `signOut` revokes and clears the session.
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

/**
 * A failure the client produces that the server never returns: the mutation
 * threw (a network blip, a bug, an unexpected server error) rather than
 * resolving to a `userError`. The flow hooks fold that into the result as
 * `OTHER_ERROR` so callers handle *every* failure through the one `userError`
 * switch and never need their own `try`/`catch`. The thrown value is preserved
 * on `cause` for callers that want to inspect or log it.
 */
export type UnexpectedFailure = {
  status: "error";
  userError: { error: "OTHER_ERROR"; cause: unknown };
};

/**
 * The result of the `continueSignIn` callback from {@link useContinueSignIn}.
 */
export type ContinueSignInHookResult =
  ClientView<ContinueSignInResult> | UnexpectedFailure;

/**
 * Client for continuing a sign-in that a provider's hook reported as
 * `incomplete`: wire the app's `continueSignIn` mutation (from `setupCore`)
 * to the core client.
 *
 * A provider that holds a sign-in on a requirement (a TOTP code, say) hands
 * the client an `attemptToken`. The client satisfies the requirement through
 * the requirement's own function, then calls the returned `continueSignIn`
 * with the token. On success this establishes an authenticated session with
 * your Convex backend, like a provider's own sign-in hook does.
 *
 * ```tsx
 * import { useContinueSignIn } from "@convex-dev/auth/react";
 * import { api } from "../convex/_generated/api";
 *
 * function CodePrompt({ attemptToken }: { attemptToken: string }) {
 *   const verify = useMutation(api.auth.verifyTotpForSignIn);
 *   const { continueSignIn, pending } = useContinueSignIn(api.auth.continueSignIn);
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const verified = await verify({ attemptToken, code });
 *         if (!verified.success) return; // show verified.userError
 *         const result = await continueSignIn({ attemptToken });
 *         if (result.status === "incomplete") {
 *           // result.requirements still stand; show the next step
 *         } else if (result.status === "error") {
 *           // SIGN_IN_EXPIRED sends the user back to the first step
 *         }
 *       }}
 *     >
 *       <button disabled={pending}>Continue</button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param continueSignInMutation The app's `continueSignIn` mutation reference.
 */
export function useContinueSignIn(continueSignInMutation: ContinueSignInFn) {
  const { setSession } = useAuthActions();
  // Running through the signInApi rather than `useMutation` is what lets this
  // hook serve both session models. See {@link useAuthSignInApi}.
  const signInApi = useAuthSignInApi();
  const [pending, setPending] = useState(false);

  const continueSignIn = useCallback(
    async (args: {
      attemptToken: string;
    }): Promise<ContinueSignInHookResult> => {
      setPending(true);
      try {
        // Under SSR the proxy has already slimmed the bundle, so what arrives
        // is the client view whatever the reference's type says.
        const result = (await signInApi.mutation(
          continueSignInMutation,
          args,
        )) as ClientView<ContinueSignInResult>;
        if (result.status === "complete") {
          await setSession(result.tokens);
        }
        return result;
      } catch (cause) {
        return { status: "error", userError: { error: "OTHER_ERROR", cause } };
      } finally {
        setPending(false);
      }
    },
    [signInApi, continueSignInMutation, setSession],
  );

  return {
    /**
     * Continues the sign-in the attempt token names.
     *
     * Returns an object with a `status` field. `"complete"` means the
     * sign-in finished and the client has established an authenticated
     * session. `"incomplete"` means a requirement still stands, named in
     * `requirements`; satisfy it and call again with the same token.
     * `"error"` carries a `userError`: `SIGN_IN_EXPIRED` when the attempt is
     * gone and the user starts over, or `OTHER_ERROR` when the call threw.
     */
    continueSignIn,
    /** `true` while the sign-in is being continued. */
    pending,
  };
}
