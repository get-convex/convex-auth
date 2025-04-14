/**
 * Svelte bindings for Convex Auth.
 *
 * @module
 */

import { ConvexClient } from "convex/browser";
import { getContext, setContext } from "svelte";
import { Value } from "convex/values";
import { createAuthClient, setConvexAuthContext } from "./client.svelte.js";
import { AuthClient } from "./clientType.js";

// Context key for Convex auth actions
const CONVEX_AUTH_ACTIONS_CONTEXT_KEY = "$$_convexAuthActions";
const CONVEX_AUTH_TOKEN_CONTEXT_KEY = "$$_convexAuthToken";

/**
 * A storage interface for storing and retrieving tokens and other secrets.
 *
 * In browsers `localStorage` and `sessionStorage` implement this interface.
 *
 * `sessionStorage` can be used for creating separate sessions for each
 * browser tab.
 *
 * For mobile apps, we recommend using a secure storage mechanism.
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
 * The result of calling `useAuthActions`.
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
  ): Promise<boolean>;
  /**
   * Sign out the current user, deleting the token from storage.
   *
   * The default implementation in {@link ConvexAuthProvider} also:
   * 1. Calls the `auth:signOut` action. This can fail if the backend is
   *    unavailable, in which case the user will be signed out on the client
   *    only.
   */
  signOut(): Promise<void>;
};

/**
 * Create the Convex auth context provider.
 *
 * ```svelte
 * <script>
 *   import { useQuery, setupConvex } from 'convex-svelte';
 *   import { createConvexAuthProvider } from '@convex-dev/auth/svelte';
 *
 *   // Set up Convex client
 *   setupConvex(import.meta.env.VITE_CONVEX_URL);
 *
 *   // Create auth provider
 *   const AuthProvider = createConvexAuthProvider();
 * </script>
 *
 * <AuthProvider>
 *   <App />
 * </AuthProvider>
 * ```
 */
export function createConvexAuthProvider() {
  // Return a Svelte component (as a function)
  return function ConvexAuthProvider({
    client,
    storage = typeof window !== "undefined" ? window.localStorage : null,
    storageNamespace,
    replaceURL = (url: string) => {
      if (typeof window !== "undefined") {
        window.history.replaceState({}, "", url);
      }
    },
    children = undefined,
  }: {
    client?: ConvexClient;
    storage?: TokenStorage | null;
    storageNamespace?: string;
    replaceURL?: (relativeUrl: string) => void | Promise<void>;
    children?: any;
  } = {}) {
    // If client is not provided, try to get it from context
    if (!client) {
      try {
        client = getContext("$$_convexClient");
      } catch (e) {
        throw new Error(
          "No ConvexClient was provided. Either pass one to ConvexAuthProvider or call setupConvex() first.",
        );
      }
    }

    // Create auth client with reactive memoization
    const authClient = $derived.by(
      () =>
        ({
          authenticatedCall(action, args) {
            return client!.action(action, args);
          },
          unauthenticatedCall(action, args) {
            return new ConvexClient((client as any).address, {
              logger: (client as any).logger,
            }).action(action, args);
          },
          verbose: (client as any).options?.verbose,
          logger: (client as any).logger,
        }) satisfies AuthClient,
    );

    // Create the auth store and set in context
    const auth = createAuthClient({
      client: authClient,
      storage,
      storageNamespace: storageNamespace ?? (client as any).address,
      replaceURL,
      onChange: async () => {
        // Handle auth state changes
        // This is a hook for implementations to use
      },
    });

    // Set auth contexts
    setConvexAuthContext(auth);
    setContext(CONVEX_AUTH_ACTIONS_CONTEXT_KEY, {
      signIn: auth.signIn,
      signOut: auth.signOut,
    });

    // Set token context (reactive)
    $effect(() => {
      let isMounted = true;

      if (auth.isAuthenticated) {
        // Use void to handle the promise without returning it
        void (async () => {
          try {
            const token = await auth.fetchAccessToken({
              forceRefreshToken: false,
            });
            if (isMounted) {
              setContext(CONVEX_AUTH_TOKEN_CONTEXT_KEY, token);
            }
          } catch (error) {
            console.error("Failed to fetch auth token:", error);
            if (isMounted) {
              setContext(CONVEX_AUTH_TOKEN_CONTEXT_KEY, null);
            }
          }
        })();
      } else {
        setContext(CONVEX_AUTH_TOKEN_CONTEXT_KEY, null);
      }

      // Return a cleanup function
      return () => {
        isMounted = false;
      };
    });

    // Return children (in Svelte, using <slot></slot>)
    return children;
  };
}

/**
 * Use this hook to access the `signIn` and `signOut` methods:
 *
 * ```ts
 * import { useAuthActions } from "@convex-dev/auth/svelte";
 *
 * function SomeComponent() {
 *   const { signIn, signOut } = useAuthActions();
 *   // ...
 * }
 * ```
 */
export function useAuthActions() {
  const actions = getContext<ConvexAuthActionsContext>(
    CONVEX_AUTH_ACTIONS_CONTEXT_KEY,
  );
  if (!actions) {
    throw new Error(
      "No auth actions found in context. Did you forget to use ConvexAuthProvider?",
    );
  }
  return actions;
}

/**
 * Use this function to access the JWT token, for authenticating
 * your Convex HTTP actions.
 *
 * You should not pass this token to other servers (think of it
 * as an "ID token").
 *
 * ```ts
 * import { useAuthToken } from "@convex-dev/auth/svelte";
 *
 * function SomeComponent() {
 *   const token = useAuthToken();
 *
 *   async function handleClick() {
 *     await fetch(`${CONVEX_SITE_URL}/someEndpoint`, {
 *       headers: {
 *         Authorization: `Bearer ${token}`,
 *       },
 *     });
 *   }
 *   // ...
 * }
 * ```
 */
export function useAuthToken(): string | null {
  return getContext<string | null>(CONVEX_AUTH_TOKEN_CONTEXT_KEY) ?? null;
}

// Re-export types
export type { AuthClient } from "./clientType.js";
