/**
 * SvelteKit implementation of Convex Auth client.
 */
import { invalidateAll, replaceState } from "$app/navigation";
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
  convexUrl: string;
  options?: ConvexClientOptions;
}) {
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
    client = setupConvexClient(convexUrl, { disabled: false, ...options });
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
    storageNamespace:
      storageNamespace ??
      requireEnv(
        typeof process !== "undefined"
          ? process.env.PUBLIC_CONVEX_URL
          : undefined,
        "PUBLIC_CONVEX_URL",
      ),
    replaceURL: (url) => {
      if (typeof window !== "undefined") {
        try {
          // Try using SvelteKit's navigation function first
          replaceState(url, {});
        } catch (error) {
          // Fall back to standard history API if SvelteKit router isn't ready
          window.history.replaceState({}, "", url);
        }
      }
    },
  });

  client.setAuth(auth.fetchAccessToken);

  // Set the auth context to ensure it's available immediately
  setConvexAuthContext(auth);

  return auth;
}

/**
 * Validate that required environment variables are present
 */
function requireEnv(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new Error(`Missing environment variable \`${name}\``);
  }
  return value;
}
