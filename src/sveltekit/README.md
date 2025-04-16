# Convex Auth for SvelteKit

This package provides authentication functionality for SvelteKit applications using Convex as a backend. It includes both client-side components and server-side utilities for a complete authentication solution.

## Installation

```bash
npm install @convex-dev/auth
# or
pnpm add @convex-dev/auth
# or
yarn add @convex-dev/auth
```

## Setup

### 1. Environment Variables

Create or update your `.env` file with the following variables:

```
PUBLIC_CONVEX_URL=your_convex_deployment_url
```

For local development, you can also create a `.env.local` file.

### 2. Configure Auth Provider (Client-side)

Set up the auth provider in your root layout:

```html
<!-- src/routes/+layout.svelte -->
<script>
  import { createSvelteKitAuthProvider } from '@convex-dev/auth/sveltekit';
  
  let { children } = $props();
  
  // Import data from +layout.server.ts 
  export let data;
  
  // Create auth provider (automatically sets up Convex client)
  const AuthProvider = createSvelteKitAuthProvider();
  
  // Alternatively, you have these options:
  
  // Option 1: Provide a custom Convex URL
  // const AuthProvider = createSvelteKitAuthProvider({
  //   convexUrl: "https://your-convex-deployment.convex.cloud"
  // });
  
  // Option 2: Provide your own ConvexClient instance
  // import { ConvexClient } from "convex/browser";
  // const client = new ConvexClient("https://your-deployment.convex.cloud");
  // const AuthProvider = createSvelteKitAuthProvider({ client });
  
  // Option 3: Use a pre-initialized Convex client from context
  // import { setupConvex } from 'convex-svelte';
  // setupConvex("https://your-deployment.convex.cloud");
  // const AuthProvider = createSvelteKitAuthProvider();
</script>

<AuthProvider serverState={data.authState}>
  {@render children()}
</AuthProvider>
```

The auth provider will:
1. Use a client you provide directly (if any)
2. Look for a client in Svelte context (if available)
3. Create a new client automatically (if needed and not disabled)

This makes it work seamlessly with different setup patterns.

### 3. Add Auth State in Layout Server

Load the authentication state in your layout server:

```typescript
// src/routes/+layout.server.ts
import { createConvexAuthHandlers } from '@convex-dev/auth/sveltekit/server';
import type { LayoutServerLoad } from './$types';

// Create auth handlers - convexUrl is automatically detected from environment 
const { loadAuthState } = createConvexAuthHandlers();

// Export load function to provide auth state to layout
export const load: LayoutServerLoad = async (event) => {
  return loadAuthState(event);
};
```

### 4. Configure Auth Hooks (Server-side)

Create hooks to handle authentication in `src/hooks.server.ts`.

#### Minimal Example:

```typescript
// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks';
import { createConvexAuthHooks } from '@convex-dev/auth/sveltekit/server';

// Create auth hooks - convexUrl is automatically detected from environment
const { handleAuth } = createConvexAuthHooks();

// Apply hooks in sequence
export const handle = sequence(
  handleAuth,  // This handles all POST requests to /api/auth automatically
  // Your other custom handlers...
);
```

#### Advanced Example:

```typescript
// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks';
import { redirect } from '@sveltejs/kit';
import { 
  createConvexAuthHooks, 
  createRouteMatcher 
} from '@convex-dev/auth/sveltekit/server';

// Example 1: Auth-first approach (whitelist pattern)
// Most routes require authentication except for a few public ones

const isPublicRoute = createRouteMatcher([
  '/login',
  '/register',
  '/about',
  // Note: No need to add '/api/auth' here as the handleAuth middleware
  // will process those requests before this middleware runs
]);

// Create auth hooks
const { handleAuth, convexAuth } = createConvexAuthHooks();

// Custom handle function for auth-first pattern
async function authFirstPattern(event) {
  // Skip auth check for public routes
  if (isPublicRoute(event.url.pathname)) {
    return;
  }
  
  // For all other routes, check authentication
  const isAuthenticated = await convexAuth.isAuthenticated(event);
  
  if (!isAuthenticated) {
    // Store the original URL for redirect after login
    const returnUrl = encodeURIComponent(event.url.pathname + event.url.search);
    return redirect(302, `/login?redirectTo=${returnUrl}`);
  }
  
  // User is authenticated, continue to next handler
  return;
}

// Example 2: Public-first approach (blacklist pattern)
// Most routes are public, only protect specific areas

const isProtectedRoute = createRouteMatcher([
  '/admin(.*)',
  '/dashboard(.*)',
  '/profile(.*)',
]);

// Custom handle function for public-first pattern
async function publicFirstPattern(event) {
  // Check auth only for protected routes
  if (isProtectedRoute(event.url.pathname)) {
    const isAuthenticated = await convexAuth.isAuthenticated(event);
    
    if (!isAuthenticated) {
      // Store the original URL for redirect after login
    const returnUrl = encodeURIComponent(event.url.pathname + event.url.search);
    return redirect(302, `/login?redirectTo=${returnUrl}`);
    }
  }
  
  // All other routes are public, or user is authenticated
  return;
}

// Choose which pattern to use based on your app's needs
// and apply hooks in sequence
export const handle = sequence(
  handleAuth,  // Handle auth API requests
  // authFirstPattern, // Uncomment to use auth-first pattern
  publicFirstPattern, // Comment out if using auth-first pattern
  // Your other custom handlers...
);
```

### Handling Special Routes

For more complex cases like handling invitations:

```typescript
// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks';
import { redirect } from '@sveltejs/kit';
import { 
  createConvexAuthHooks, 
  createRouteMatcher 
} from '@convex-dev/auth/sveltekit/server';
import { api } from '@/convex/_generated/api';
import { fetchMutation } from 'convex/svelte';

// Create auth hooks
const { handleAuth, convexAuth } = createConvexAuthHooks();

// Handle special route for invitation acceptance
const isInvitationRoute = createRouteMatcher(['/api/invitations/accept']);

async function handleSpecialRoutes(event) {
  if (isInvitationRoute(event.url.pathname)) {
    const isAuthenticated = await convexAuth.isAuthenticated(event);
    
    if (!isAuthenticated) {
      // Redirect to login with return URL
      return redirect(302, 
        `/login?returnUrl=${encodeURIComponent(event.url.pathname + event.url.search)}`
      );
    }
    
    // Get invitation ID from query params
    const invitationId = event.url.searchParams.get('invitationId');
    
    if (invitationId) {
      try {
        // Get auth token from server state
        const authState = await convexAuth.getAuthState(event);
        const token = authState._state.token;
        
        // Call the mutation with the auth token
        await fetchMutation(
          api.organizations.invitations.accept,
          { invitationId },
          { token }
        );
        
        // Redirect to success page
        return redirect(302, '/dashboard');
      } catch (error) {
        console.error('Error accepting invitation:', error);
        return new Response(JSON.stringify({ error: 'Failed to accept invitation' }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  }
  
  // Not a special route, continue to next handler
  return;
}

export const handle = sequence(
  handleAuth,  // Handle auth API requests
  handleSpecialRoutes, // Handle special routes
  // Add your auth pattern here...
  // Your other custom handlers...
);
```

## Usage

### Pages (`+page.svelte`)

Use authentication in your pages:

```html
<!-- src/routes/+page.svelte -->
<script>
  import { useAuth } from '@convex-dev/auth/svelte';
  
  // Get auth state and actions
  const { isAuthenticated, isLoading, signIn, signOut } = useAuth();
</script>

{#if isLoading}
  <p>Loading authentication state...</p>
{:else if isAuthenticated}
  <h1>Welcome, authenticated user!</h1>
  <button on:click={() => signOut()}>Sign Out</button>
{:else}
  <h1>Please sign in</h1>
  <button on:click={() => signIn('google')}>
    Sign in with Google
  </button>
</div>
{/if}
```

### Page Server (`+page.server.ts`)

Use auth state in page server load functions:

```typescript
// src/routes/profile/+page.server.ts
import { createConvexAuthHandlers } from '@convex-dev/auth/sveltekit/server';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Create auth handlers
const { isAuthenticated } = createConvexAuthHandlers();

// Protect routes at the page level
export const load: PageServerLoad = async (event) => {
  // Check if user is authenticated
  if (!(await isAuthenticated(event))) {
    // Redirect to login if not authenticated
    throw redirect(302, '/login');
  }
  
  // Return data for authenticated users
  return {
    user: { /* user data */ }
  };
};
```

## Protecting Routes

### Option 1: Using Hooks (App-wide Protection)

Configure route protection patterns in your `hooks.server.ts`:

```typescript
// src/hooks.server.ts
import { createConvexAuthHooks, createRouteMatcher } from '@convex-dev/auth/sveltekit/server';

// Create a matcher for protected routes
const protectedRoutes = createRouteMatcher((path) => {
  return path.startsWith('/dashboard') || 
         path.startsWith('/profile') ||
         path.startsWith('/admin');
});

// Create auth hooks with route protection
const { handleAuth, protectRoutes } = createConvexAuthHooks({
  protectedRoutes,
  // Where to redirect unauthenticated users
  redirectUrl: '/login'
});

export const handle = sequence(handleAuth, protectRoutes);
```

### Option 2: Using Page Server Load (Page-level Protection)

Protect individual pages in their `+page.server.ts`:

```typescript
// src/routes/protected/+page.server.ts
import { redirect } from '@sveltejs/kit';
import { createConvexAuthHandlers } from '@convex-dev/auth/sveltekit/server';

const { isAuthenticated } = createConvexAuthHandlers();

export async function load(event) {
  if (!(await isAuthenticated(event))) {
    throw redirect(302, '/login?redirectTo=' + event.url.pathname);
  }
  
  return {
    // Page data here
  };
}
```

## Authentication Actions

### Sign In

```html
<script>
  import { useAuth } from '@convex-dev/auth/svelte';
  
  const { signIn } = useAuth();
  
  // Available auth providers: 'google', 'github', etc.
  function handleSignIn() {
    signIn('google');
  }
  
  // With params (e.g., for email+password)
  function handleEmailSignIn(email, password) {
    signIn('email', { email, password });
  }
</script>
```

### Sign Out

```html
<script>
  import { useAuth } from '@convex-dev/auth/svelte';
  
  const { signOut } = useAuth();
  
  function handleSignOut() {
    signOut();
  }
</script>
```

### Check Auth State

```html
<script>
  import { useAuth } from '@convex-dev/auth/svelte';
  
  const { isAuthenticated, isLoading } = useAuth();
</script>

{#if isLoading}
  <p>Loading...</p>
{:else if isAuthenticated}
  <p>You are signed in!</p>
{:else}
  <p>Not signed in.</p>
{/if}
```

## Advanced Usage

### Custom Redirect Handler

```typescript
// src/hooks.server.ts
const { handleAuth, protectRoutes } = createConvexAuthHooks({
  onUnauthenticated: (event) => {
    // Custom redirect logic
    const url = new URL('/login', event.url.origin);
    url.searchParams.set('from', event.url.pathname);
    return new Response(null, {
      status: 302,
      headers: { Location: url.toString() }
    });
  }
});
```

### Route Matcher Patterns

```typescript
// Match single route
createRouteMatcher('/dashboard');

// Match with regex
createRouteMatcher(/^\/api\/private\/.*$/);

// Match with function
createRouteMatcher((path) => path.includes('/admin/'));

// Match multiple patterns (OR)
createRouteMatcherGroup([
  '/dashboard',
  /^\/profile\/.*$/,
  (path) => path.startsWith('/settings')
]);
```

### Manual Token Handling

```html
<script>
  import { useAuth } from '@convex-dev/auth/svelte';
  
  const { fetchAccessToken } = useAuth();
  
  async function makeAuthenticatedRequest() {
    const token = await fetchAccessToken({ forceRefreshToken: false });
    
    // Use token for custom fetch requests
    const response = await fetch('/api/protected', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
  }
</script>
```

### Alternative: Custom API Endpoint

If you prefer to handle auth requests with a dedicated endpoint (instead of using the hooks approach), create a file at `src/routes/api/auth/+server.ts`:

```typescript
// src/routes/api/auth/+server.ts
import { createConvexAuthHandlers } from '@convex-dev/auth/sveltekit/server';
import type { RequestHandler } from '@sveltejs/kit';

// Create auth handlers
const { handleAuthAction } = createConvexAuthHandlers();

// Export POST handler for auth requests
export const POST: RequestHandler = handleAuthAction;
```

When using this approach, make sure to update your Auth Provider to use the same API route:

```html
<AuthProvider apiRoute="/api/auth" serverState={data.authState}>
  {@render children()}
</AuthProvider>
```

## Troubleshooting

### Common Issues

1. **Auth Tokens Not Persisting**: Ensure cookie options are configured correctly, especially `secure` and `sameSite`.

2. **CORS Errors**: If your Convex backend is on a different domain, you may need to configure CORS.

3. **TypeScript Errors with `$env/static/public`**: Make sure you have run your SvelteKit app at least once to generate the proper type definitions.

### Debug Mode

Enable debug logging by setting an environment variable:

```
CONVEX_AUTH_DEBUG=true
```

This will output detailed logs about auth operations to help with troubleshooting.

## License

MIT
