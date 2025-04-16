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
 *   import { createSvelteKitAuthProvider } from '@convex-dev/auth/sveltekit';
 *   
 *   // Get server-side auth state (in +layout.server.ts)
 *   export let data;
 *   
 *   // Create auth provider (will set up Convex client automatically)
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
import { setupConvex } from "convex-svelte";
import { getContext } from "svelte";
import { ConvexClient } from "convex/browser";

export function createSvelteKitAuthProvider(options?: {
  /** 
   * ConvexClient instance to use. If not provided, will:
   * 1. Try to get it from Svelte context
   * 2. Initialize a new one using the Convex URL
   */
  client?: ConvexClient;
  
  /** 
   * Convex URL to use if creating a new client. If not provided, will use 
   * PUBLIC_CONVEX_URL environment variable.
   */
  convexUrl?: string;
}) {
  const { client: providedClient, convexUrl } = options || {};
  
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
    
    // Determine which client to use:
    // 1. Use provided client if it exists
    let client = providedClient;
    
    // 2. Try to get from context if not provided
    if (!client) {
      try {
        client = getContext("$$_convexClient");
      } catch (e) {
        // Context not available or no client in context
      }
    }
    
    // 3. Create a new client if requested and not found
    if (!client) {
      // Get URL from options or environment variable
      const url = convexUrl || 
                  (typeof process !== "undefined" ? process.env.PUBLIC_CONVEX_URL : undefined) ||
                  (typeof window !== "undefined" && (window as any).PUBLIC_CONVEX_URL);
      
      if (!url) {
        console.warn("No Convex URL provided. Please pass client or convexUrl to createSvelteKitAuthProvider or set PUBLIC_CONVEX_URL environment variable.");
      } else {
        // This will set the client in context for future use
        setupConvex(url);
        
        // Try to get the newly created client
        try {
          client = getContext("$$_convexClient");
        } catch (e) {
          // Context not available after setup
        }
      }
    }
    
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
      client, // Will pass through our client or undefined
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
