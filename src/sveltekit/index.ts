/**
 * SvelteKit bindings for Convex Auth.
 *
 * @module
 */

export { 
  useAuthActions, 
  useAuthToken, 
  type TokenStorage, 
  type ConvexAuthActionsContext
} from "../svelte/index.svelte.js";

export { 
  createSvelteKitAuthClient, 
  type ConvexAuthServerState, 
} from "./client.js";

/**
 * Create a SvelteKit auth provider component that can be used to provide
 * authentication state to child components.
 * 
 * @returns A Svelte component that provides auth context to children
 * 
 * Usage:
 * ```svelte
 * <script>
 *   import { useQuery, setupConvex } from 'convex-svelte';
 *   import { createSvelteKitAuthProvider } from '@convex-dev/auth/sveltekit';
 *   
 *   // Set up Convex client
 *   setupConvex(import.meta.env.PUBLIC_CONVEX_URL);
 *   
 *   // Get server-side auth state (in +layout.svelte or +page.svelte)
 *   export let data;
 *   
 *   // Create auth provider
 *   const AuthProvider = createSvelteKitAuthProvider();
 * </script>
 * 
 * <AuthProvider serverState={data.authState}>
 *   <slot />
 * </AuthProvider>
 * ```
 */
import { createConvexAuthProvider } from "../svelte/index.svelte.js";
import { createSvelteKitAuthClient, type ConvexAuthServerState } from "./client.js";

export function createSvelteKitAuthProvider() {
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
    // Create the base auth provider
    const AuthProvider = createConvexAuthProvider();
    
    // Create the SvelteKit-specific auth client but don't use it directly
    // We're creating it so it sets up the SvelteKit-specific authentication
    // context that will be used by child components
    createSvelteKitAuthClient({
      apiRoute,
      serverState,
      storage,
      storageNamespace,
      verbose,
    });
    
    // Return the auth provider with SvelteKit-specific configuration
    // We pass undefined for client so it will use the one from context setup by setupConvex
    return AuthProvider({
      client: undefined, // Will get ConvexClient from context
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
