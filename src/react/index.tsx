/**
 * React bindings for Convex Auth.
 *
 * @module
 */

"use client";

import { ConvexHttpClient } from "convex/browser";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { Value } from "convex/values";
import { ReactNode, useContext, useMemo } from "react";
import {
  AuthProvider,
  ConvexAuthActionsContext,
  ConvexAuthTokenContext,
  useAuth,
} from "./client.js";
import { AuthClient } from "./clientType.js";

/**
 * Use this hook to access the `signIn` and `signOut` methods:
 *
 * ```ts
 * import { useAuthActions } from "@convex-dev/auth/react";
 *
 * function SomeComponent() {
 *   const { signIn, signOut } = useAuthActions();
 *   // ...
 * }
 * ```
 */
export function useAuthActions() {
  return useContext(ConvexAuthActionsContext);
}

/**
 * Replace your `ConvexProvider` with this component to enable authentication.
 *
 * ```tsx
 * import { ConvexAuthProvider } from "@convex-dev/auth/react";
 * import { ConvexReactClient } from "convex/react";
 * import { ReactNode } from "react";
 *
 * const convex = new ConvexReactClient(/* ... *\/);
 *
 * function RootComponent({ children }: { children: ReactNode }) {
 *   return <ConvexAuthProvider client={convex}>{children}</ConvexAuthProvider>;
 * }
 * ```
 */
export function ConvexAuthProvider(props: {
  /**
   * Your [`ConvexReactClient`](https://docs.convex.dev/api/classes/react.ConvexReactClient).
   */
  client: ConvexReactClient;
  /**
   * Optional custom storage object that implements
   * the {@link TokenStorage} interface, otherwise
   * [`localStorage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)
   * is used.
   *
   * You must set this for React Native.
   */
  storage?: TokenStorage;
  /**
   * Optional namespace for keys used to store tokens. The keys
   * determine whether the tokens are shared or not.
   *
   * Any non-alphanumeric characters will be ignored (for RN compatibility).
   *
   * Defaults to the deployment URL, as configured in the given `client`.
   */
  storageNamespace?: string;
  /**
   * Provide this function if you're using a JS router (Expo router etc.)
   * and after OAuth or magic link sign-in the `code` param is not being
   * erased from the URL.
   *
   * The implementation will depend on your chosen router.
   */
  replaceURL?: (
    /**
     * The URL, always starting with '/' and include the path, query and
     * fragment components, that the window location should be set to.
     */
    relativeUrl: string,
  ) => void | Promise<void>;
  /**
   * If this function returns false, the auth provider will not attempt to handle the
   * code param from the URL.
   */
  shouldHandleCode?: (() => boolean) | boolean;
  /**
   * Children components can call Convex hooks
   */
  children: ReactNode;
}) {
  const {
    client,
    storage,
    storageNamespace,
    replaceURL,
    shouldHandleCode,
    children,
  } = props;
  const authClient = useMemo(
    () =>
      ({
        authenticatedCall(action, args) {
          return client.action(action, args);
        },
        unauthenticatedCall(action, args) {
          return new ConvexHttpClient((client as any).address, {
            logger: client.logger,
          }).action(action, args);
        },
        verbose: (client as any).options?.verbose,
        logger: client.logger,
      }) satisfies AuthClient,
    [client],
  );
  return (
    <AuthProvider
      client={authClient}
      storage={
        storage ??
        // Handle SSR, RN, Web, etc.
        // Pretend we always have storage, the component checks
        // it in first useEffect.
        (typeof window === "undefined" ? undefined : window?.localStorage)!
      }
      storageNamespace={storageNamespace ?? (client as any).address}
      replaceURL={
        replaceURL ??
        ((url) => {
          window.history.replaceState({}, "", url);
        })
      }
      shouldHandleCode={shouldHandleCode}
    >
      <ConvexProviderWithAuth client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthProvider>
  );
}

/**
 * A storage interface for storing and retrieving tokens and other secrets.
 *
 * In browsers `localStorage` and `sessionStorage` implement this interface.
 *
 * `sessionStorage` can be used for creating separate sessions for each
 * browser tab.
 *
 * In React Native we recommend wrapping `expo-secure-store`.
 */
export interface TokenStorage {
  /**
   * Read a value.
   * @param key Unique key.
   */
  getItem: (
    key: string,
  ) => string | undefined | null | Promise<string | undefined | null>;
  /**
   * Write a value.
   * @param key Unique key.
   * @param value The value to store.
   */
  setItem: (key: string, value: string) => void | Promise<void>;
  /**
   * Remove a value.
   * @param key Unique key.
   */
  removeItem: (key: string) => void | Promise<void>;
}

/**
 * The result of calling {@link useAuthActions}.
 */
export type ConvexAuthActionsContext = {
  /**
   * Sign in via one of your configured authentication providers.
   *
   * @returns Whether the user was immediately signed in (ie. the sign-in
   *          didn't trigger an additional step like email verification
   *          or OAuth signin).
   */
  signIn(
    this: void,
    /**
     * The ID of the provider (lowercase version of the
     * provider name or a configured `id` option value).
     */
    provider: string,
    /**
     * Either a `FormData` object containing the sign-in
     *        parameters or a plain object containing them.
     *        The shape required depends on the chosen provider's
     *        implementation.
     *
     * Special fields:
     *  - `redirectTo`: If provided, customizes the destination the user is
     *     redirected to at the end of an OAuth flow or the magic link URL.
     *     See [redirect callback](https://labs.convex.dev/auth/api_reference/server#callbacksredirect).
     *  - `code`: OTP code for email or phone verification, or
     *     (used only in RN) the code from an OAuth flow or magic link URL.
     */
    params?:
      | FormData
      | (Record<string, Value> & {
          /**
           * If provided, customizes the destination the user is
           * redirected to at the end of an OAuth flow or the magic link URL.
           */
          redirectTo?: string;
          /**
           * OTP code for email or phone verification, or
           * (used only in RN) the code from an OAuth flow or magic link URL.
           */
          code?: string;
        }),
  ): Promise<{
    /**
     * Whether the call led to an immediate successful sign-in.
     *
     * Note that there's a delay between the `signIn` function
     * returning and the client performing the handshake with
     * the server to confirm the sign-in.
     */
    signingIn: boolean;
    /**
     * If the sign-in started an OAuth flow, this is the URL
     * the browser should be redirected to.
     *
     * Useful in RN for opening the in-app browser to
     * this URL.
     */
    redirect?: URL;
  }>;

  /**
   * Sign out the current user.
   *
   * Calls the server to invalidate the server session
   * and deletes the locally stored JWT and refresh token.
   */
  signOut(this: void): Promise<void>;
};

/**
 * Use this hook to access the JWT token on the client, for authenticating
 * your Convex HTTP actions.
 *
 * You should not pass this token to other servers (think of it
 * as an "ID token").
 *
 * ```ts
 * import { useAuthToken } from "@convex-dev/auth/react";
 *
 * function SomeComponent() {
 *   const token = useAuthToken();
 *   const onClick = async () => {
 *     await fetch(`${CONVEX_SITE_URL}/someEndpoint`, {
 *       headers: {
 *         Authorization: `Bearer ${token}`,
 *       },
 *     });
 *   };
 *   // ...
 * }
 * ```
 */
export function useAuthToken() {
  return useContext(ConvexAuthTokenContext);
}
