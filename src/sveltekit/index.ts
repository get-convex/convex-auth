/**
 * SvelteKit bindings for Convex Auth.
 *
 * @module
 */

import { 
  createConvexAuthProvider, 
  useAuthActions, 
  getConvexAuthToken, 
  useAuthToken, 
  type TokenStorage, 
  type ConvexAuthActionsContext 
} from "../svelte/index.svelte";

import { ConvexClient } from "convex/browser";
import { createSvelteKitAuthClient, type ConvexAuthServerState } from "./client";

/**
 * Create a SvelteKit auth provider component that can be used to provide
 * authentication state to child components.
 * 
 * @returns A Svelte component that provides auth context to children
 * 
 * Usage:
 * ```svelte
 * <script>
 *   import { createSvelteKitAuthProvider } from '@convex-dev/auth/sveltekit';
 *   
 *   let { children } = $props();
 * 
 *   // Get server-side auth state (in +layout.server.ts)
 *   export let data;
 *   
 *   // Create auth provider (will set up Convex client automatically)
 *   const AuthProvider = createSvelteKitAuthProvider();
 * </script>
 * 
 * <AuthProvider serverState={data.authState}>
 *   {@render children()}
 * </AuthProvider>
 * ```
 */

/**
 * Create a SvelteKit-specific auth provider component
 */
export function createSvelteKitAuthProvider(options?: {
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
}) {
  // Create the base provider with our options
  const AuthProvider = createConvexAuthProvider(options);
  
  // Return a component factory function
  return function ConvexAuthSvelteKitProvider({
    apiRoute = "/api/auth",
    serverState,
    storage = "localStorage",
    storageNamespace,
    verbose = false,
    children,
  }: {
    apiRoute?: string;
    serverState?: ConvexAuthServerState;
    storage?: "localStorage" | "inMemory";
    storageNamespace?: string;
    verbose?: boolean;
    children?: any;
  } = {}) {
    // Create the SvelteKit-specific auth client
    createSvelteKitAuthClient({
      apiRoute,
      serverState,
      storage,
      storageNamespace,
      verbose,
    });
    
    // Return the auth provider with SvelteKit-specific configuration
    return AuthProvider({
      storage: typeof window === "undefined"
        ? null
        : storage === "inMemory"
          ? null
          : window.localStorage,
      storageNamespace,
      children,
    });
  };
}

// Re-export core functionality
export { 
  createSvelteKitAuthClient,
  useAuthActions, 
  getConvexAuthToken, 
  useAuthToken 
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
