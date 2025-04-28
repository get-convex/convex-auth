/**
 * SvelteKit implementation of Convex Auth client.
 */
import { invalidateAll, replaceState } from "$app/navigation";
import { env } from "$env/dynamic/public";
import {
  createAuthClient,
  setConvexAuthContext,
  setupConvexClient,
} from "../svelte/client.svelte.js";
import { AuthClient } from "../svelte/clientType.js";
import { ConvexClient, ConvexClientOptions } from "convex/browser";

/**
 * Type definition for the server state from SvelteKit
 */
export type ConvexAuthServerState = {
  _state: { token: string | null; refreshToken: string | null };
  _timeFetched: number;
};

/**
 * Create a Convex Auth client for SvelteKit
 */
export function createSvelteKitAuthClient({
  apiRoute = "/api/auth",
  serverState,
  storage = "localStorage",
  storageNamespace,
  client,
  convexUrl,
  options,
}: {
  apiRoute?: string;
  serverState?: ConvexAuthServerState;
  storage?: "localStorage" | "inMemory";
  storageNamespace?: string;
  client?: ConvexClient;
  convexUrl?: string;
  options?: ConvexClientOptions;
}) {
  const url =
    convexUrl ??
    env.PUBLIC_CONVEX_URL ??
    (() => {
      throw new Error(
        "No Convex URL provided. Either pass convexUrl parameter or set PUBLIC_CONVEX_URL environment variable.",
      );
    })();

  const call: AuthClient["authenticatedCall"] = async (action, args) => {
    const params = { action, args };
    const response = await fetch(apiRoute, {
      body: JSON.stringify(params),
      method: "POST",
    });
    return await response.json();
  };

  const authClient: AuthClient = {
    authenticatedCall: call,
    unauthenticatedCall: call,
    verbose: options?.verbose,
    logger: options?.logger,
  };

  // Initialize the Convex client if not provided
  if (!client) {
    client = setupConvexClient(url, { disabled: false, ...options });
  }

  // Create the auth client with SvelteKit-specific config
  const auth = createAuthClient({
    client: authClient,
    serverState,
    onChange: async () => {
      // Invalidate SvelteKit data on auth changes
      await invalidateAll();
    },
    storage:
      // Handle SSR, Client, etc.
      // Pretend we always have storage, the component checks
      // it in first useEffect.
      typeof window === "undefined"
        ? null
        : storage === "inMemory"
          ? null
          : window.localStorage,
    storageNamespace: storageNamespace ?? url,
    replaceURL: (url) => {
      // Not used, since the redirect is handled by the SvelteKit server.
      const attemptSvelteKitNavigation = (retryCount = 0, maxRetries = 3) => {
        try {
          replaceState(url, {});
          // Success - no need for further retries
        } catch (error) {
          if (retryCount < maxRetries) {
            // Exponential backoff for retries (100ms, 200ms, 400ms)
            setTimeout(
              () => {
                attemptSvelteKitNavigation(retryCount + 1, maxRetries);
              },
              100 * Math.pow(2, retryCount),
            );
          }
        }
      };

      // Start retry attempts after a short delay
      setTimeout(() => attemptSvelteKitNavigation(), 50);
    },
  });

  client.setAuth(auth.fetchAccessToken);

  // Set the auth context to ensure it's available immediately
  setConvexAuthContext(auth);

  return auth;
}
