/**
 * Svelte bindings for Convex Auth.
 *
 * @module
 */

import { ConvexClient, ConvexClientOptions } from "convex/browser";
import {
  createAuthClient,
  setConvexAuthContext,
  getConvexAuthContext,
  setupConvexClient,
} from "./client.svelte.js";
import { AuthClient } from "./clientType.js";

/**
 * Parameters for sign-in methods
 */
type SignInParams =
  | FormData
  | (Record<string, any> & {
      redirectTo?: string;
      code?: string;
    });

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
 * Type definition for the server state
 */
export type ConvexAuthServerState = {
  _state: { token: string | null; refreshToken: string | null };
  _timeFetched: number;
};

/**
 * Initialize Convex Auth for Svelte.
 *
 * This function sets up authentication for your Svelte application.
 * It should be called in your root layout or App component.
 *
 * @returns The auth client instance that can be used to access auth methods
 *
 * Usage:
 * ```svelte
 * <script>
 *   import { setupConvexAuth } from '@convex-dev/auth/svelte';
 *
 *   // Set up authentication
 *   setupConvexAuth();
 * </script>
 *
 * <!-- Your app content here -->
 * ```
 */
export function setupConvexAuth({
  client,
  storage = typeof window !== "undefined" ? window.localStorage : null,
  storageNamespace,
  replaceURL = (url: string) => {
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", url);
    }
  },
  convexUrl,
  options,
}: {
  /** ConvexClient instance to use */
  client?: ConvexClient;
  /**
   * Optional custom storage object that implements
   * the {@link TokenStorage} interface, otherwise
   * [`localStorage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)
   * is used.
   *
   * You must set this for Svelte Native.
   */
  storage?: TokenStorage | null;
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
   * The url of your Convex deployment, often provided
   * by an environment variable. E.g. `https://small-mouse-123.convex.cloud`.
   */
  convexUrl: string;

  options?: ConvexClientOptions;
}) {
  
  if (!client) {
    client = setupConvexClient(convexUrl, options);
  }

  // Create auth client
  const authClient: AuthClient = {
    authenticatedCall(action, args) {
      return client.action(action, args);
    },
    unauthenticatedCall(action, args) {
      return new ConvexClient(convexUrl, {
        logger: options?.logger,
      }).action(action, args);
    },
    verbose: options?.verbose,
    logger: options?.logger,
  };

  // Create the auth client and set up context
  const auth = createAuthClient({
    client: authClient,
    storage,
    storageNamespace: storageNamespace ?? convexUrl,
    replaceURL,
    onChange: async () => {
      // Handle auth state changes
      // This is a hook for implementations to use
    },
    options,
  });

  client.setAuth(auth.fetchAccessToken)

  // Set auth context
  setConvexAuthContext(auth);

  return auth;
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
    params?: SignInParams,
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
 * Use this function to access all authentication functionality including state, token, and actions.
 *
 * ```ts
 * import { useAuth } from "@convex-dev/auth/svelte";
 *
 * function SomeComponent() {
 *   const { isLoading, isAuthenticated, token, signIn, signOut } = useAuth();
 *
 *   // Use authentication state
 *   if (isLoading) {
 *     return <p>Loading...</p>;
 *   }
 *
 *   if (isAuthenticated) {
 *     return (
 *       <div>
 *         <p>You are signed in!</p>
 *         <button onClick={() => signOut()}>Sign Out</button>
 *       </div>
 *     );
 *   }
 *
 *   return (
 *     <div>
 *       <p>You need to sign in</p>
 *       <button onClick={() => signIn("google")}>Sign In with Google</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useAuth(): {
  isLoading: boolean;
  isAuthenticated: boolean;
  token: string | null;
  fetchAccessToken: () => Promise<string | null>;
  signIn: (provider: string, params?: SignInParams) => Promise<{
    signingIn: boolean;
    redirect?: URL;
  }>;
  signOut: () => Promise<void>;
} {
  try {
    // Get the auth client from context
    const auth = getConvexAuthContext();

    if (!auth) {
      throw new Error("setupConvexAuth must be called before useAuth");
    }

    // Return a unified object with all auth functionality
    return {
      // Auth state
      get isLoading() {
        return auth.isLoading;
      },
      get isAuthenticated() {
        return auth.isAuthenticated;
      },

      // Auth token
      get token() {
        return auth.token;
      },
      fetchAccessToken: () => auth.fetchAccessToken(),

      // Auth actions
      signIn: (provider: string, params?: SignInParams) =>
        auth.signIn(provider, params),
      signOut: () => auth.signOut(),
    };
  } catch (e) {
    throw new Error("setupConvexAuth must be called before useAuth");
  }
}

// Re-export types
export type { AuthClient } from "./clientType.js";
