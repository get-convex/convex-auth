/**
 * SvelteKit implementation of Convex Auth client.
 */
import { invalidateAll } from "$app/navigation";
import { createAuthClient } from "../svelte/client.svelte.js";
import { AuthClient } from "../svelte/clientType.js";
import { PUBLIC_CONVEX_URL } from '$env/static/public';

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
  verbose,
}: {
  apiRoute?: string;
  serverState?: ConvexAuthServerState;
  storage?: "localStorage" | "inMemory";
  storageNamespace?: string;
  verbose?: boolean;
}) {
  // Create SvelteKit-specific auth client
  const authenticatedCall: AuthClient["authenticatedCall"] = async (action, args) => {
    const params = { action, args };
    const response = await fetch(apiRoute, {
      body: JSON.stringify(params),
      method: "POST",
    });
    return await response.json();
  };

  const authClient: AuthClient = {
    authenticatedCall,
    unauthenticatedCall: authenticatedCall,
    verbose,
  };

  // Create the auth client with SvelteKit-specific config
  return createAuthClient({
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
      requireEnv(PUBLIC_CONVEX_URL, "PUBLIC_CONVEX_URL"),
    replaceURL: (url) => {
      if (typeof window !== "undefined") {
        window.history.replaceState({}, "", url);
      }
    },
  });
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
