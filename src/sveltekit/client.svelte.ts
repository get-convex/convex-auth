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
import { ConvexAuthServerState } from "../svelte/index.svelte";
import { logVerbose } from "./server/utils.js";

/**
 * Create a Convex Auth client for SvelteKit
 */
export function createSvelteKitAuthClient({
  apiRoute = "/api/auth",
  getServerState: getServerState,
  storage = "localStorage",
  storageNamespace,
  client,
  convexUrl,
  options,
}: {
  apiRoute?: string;
  getServerState: () => ConvexAuthServerState;
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
    getServerState,
    onChange: async () => {
      console.log("\n**onChange invalidateAll**\n");
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
    options,
  });

  $effect(() => {
    const s = getServerState(); // fresh each invalidation
    logVerbose(
      `Update convex client setAuth to ${s._state.token ? "Authenticated" : "Unauthenticated"}`,
      options?.verbose,
    );

    if (s._state.token) {
      client.setAuth(auth.fetchAccessToken);
    }
  });

  // Set the auth context to ensure it's available immediately
  setConvexAuthContext(auth);

  return auth;
}
