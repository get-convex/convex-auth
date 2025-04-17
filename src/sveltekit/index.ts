/**
 * SvelteKit bindings for Convex Auth.
 *
 * @module
 */

import { 
  setupConvexAuth as setupSvelteConvexAuth, 
  useAuth,
  type TokenStorage, 
  type ConvexAuthActionsContext 
} from "../svelte/index.svelte";

import { ConvexClient } from "convex/browser";
import { createSvelteKitAuthClient, type ConvexAuthServerState } from "./client";

/**
 * Initialize Convex Auth for SvelteKit.
 * 
 * This function sets up authentication for your SvelteKit application.
 * It should be called in your root +layout.svelte file.
 * 
 * @returns The auth client instance that can be used to access auth methods
 * 
 * Usage:
 * ```svelte
 * <script>
 *   import { setupConvexAuth } from '@convex-dev/auth/sveltekit';
 *   
 *   // Get server-side auth state (in +layout.server.ts)
 *   export let data;
 *   
 *   // Set up authentication (will initialize Convex client automatically)
 *   setupConvexAuth({ serverState: data.authState });
 * </script>
 * 
 * {@render children()}
 * ```
 */
export function setupConvexAuth({
  apiRoute = "/api/auth",
  serverState,
  storage = "localStorage",
  storageNamespace,
  verbose = false,
  client,
  convexUrl
}: {
  /** API route to use for auth requests */
  apiRoute?: string;
  /** Server-provided authentication state */
  serverState?: ConvexAuthServerState;
  /** Storage type to use */
  storage?: "localStorage" | "inMemory";
  /** Storage namespace for auth tokens */
  storageNamespace?: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** 
   * ConvexClient instance to use. If not provided, will:
   * 1. Try to get it from Svelte context
   * 2. Initialize a new one using the Convex URL
   */
  client?: ConvexClient;
  /** 
   * Convex URL to use. If not provided, will use 
   * PUBLIC_CONVEX_URL environment variable.
   */
  convexUrl?: string;
} = {}) {
  // Initialize the base Svelte auth
  setupSvelteConvexAuth({ client, convexUrl });
  
  // Return the initialized auth client
  return createSvelteKitAuthClient({
    apiRoute,
    serverState,
    storage,
    storageNamespace,
    verbose,
  });
}


// Re-export core functionality
export { 
  createSvelteKitAuthClient,
  useAuth
};

// Re-export types
export type { 
  TokenStorage, 
  ConvexAuthActionsContext,
  ConvexAuthServerState 
};

/**
 * Create server-side handlers for SvelteKit.
 * This provides utilities to work with Convex Auth in SvelteKit.
 * 
 * Usage in hooks.server.ts:
 * ```ts
 * import { createConvexAuthHandlers } from '@convex-dev/auth/sveltekit/server';
 * 
 * const { getAuthState } = createConvexAuthHandlers({
 *   convexUrl: process.env.CONVEX_URL!,
 * });
 * 
 * export async function handle({ event, resolve }) {
 *   // Add auth state to event.locals
 *   event.locals.authState = await getAuthState(event);
 *   return resolve(event);
 * }
 * ```
 */
export { createConvexAuthHandlers } from "./server/handlers.js";
