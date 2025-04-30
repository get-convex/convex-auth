# Convex Auth for SvelteKit

This package provides authentication functionality for SvelteKit applications using Convex as a backend. It includes both client-side components and server-side utilities for a complete authentication solution.

## Installation

```bash
npm install @convex-dev/auth @auth/core
# or
pnpm add @convex-dev/auth @auth/core
# or
yarn add @convex-dev/auth @auth/core
```

## Setup

### 1. Environment Variables

Create or update your `.env` file with the following variables:

```bash
PUBLIC_CONVEX_URL=your_convex_deployment_url
```

For local development, you can also create a `.env.local` file.

### 2. Run the initialization command

```bash
npx @convex-dev/auth
```

This sets up your project for authenticating via the library.

### 3. Initialize Auth (Client-side)

Set up authentication in your root layout:

```html
<!-- src/routes/+layout.svelte -->
<script>
  import { setupConvexAuth } from '@convex-dev/auth/sveltekit';
  
  // Import data from +layout.server.ts 
  let { children, data } = $props();

  let authState = $state(data.authState);
  
  // Set up authentication (automatically initializes Convex client)
  setupConvexAuth({ serverState: authState });
  
  // Alternatively, you have these options:
  
  // Option 1: Provide a custom Convex URL
  // setupConvexAuth({
  //   serverState: data.authState,
  //   convexUrl: "https://your-convex-deployment.convex.cloud"
  // });
  
  // Option 2: Provide your own ConvexClient instance
  // import { ConvexClient } from "convex/browser";
  // const client = new ConvexClient("https://your-deployment.convex.cloud");
  // setupConvexAuth({ serverState: data.authState, client });
</script>

{@render children()}
```

The `setupConvexAuth` function will try to create a Convex client in the following order:
1. Use a client you provide directly (if any)
2. Look for a client in Svelte context (if available)
3. Create a new client automatically 

This makes it work seamlessly with different setup patterns.

### 4. Add Auth State in Layout Server

Load the authentication state in your layout server:

```ts
// src/routes/+layout.server.ts
import { createConvexAuthHandlers } from '@convex-dev/auth/sveltekit/server';
import type { LayoutServerLoad } from './$types';

// Create auth handlers - convexUrl is automatically detected from environment 
const { getAuthState } = createConvexAuthHandlers();

// Export load function to provide auth state to layout
export const load: LayoutServerLoad = async (event) => {
  return { authState: await getAuthState(event) };
};
```

### 5. Configure Auth Hooks (Server-side)

Create hooks to handle authentication in `src/hooks.server.ts`.

```ts
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


## Usage

### Pages (`+page.svelte`)

Use authentication in your pages:

```html
<!-- src/routes/+page.svelte -->
<script>
  import { useAuth } from '@convex-dev/auth/svelte';

  const isAuthenticated = $derived(useAuth().isAuthenticated);
  const isLoading = $derived(useAuth().isLoading);
  const { signIn, signOut } = useAuth();
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

```ts
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

### Option 1: Using Hooks (App-wide Protection) (Recommended)

#### Example 1: Auth-first approach (whitelist pattern)
Most routes require authentication except for a few public ones
```ts
const isPublicRoute = createRouteMatcher([
  '/login',
  '/register',
  '/about',
]);
```

```ts
// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks';
import { redirect, type Handle } from '@sveltejs/kit';
import { 
  createConvexAuthHooks, 
  createRouteMatcher 
} from '@convex-dev/auth/sveltekit/server';

const isPublicRoute = createRouteMatcher([
  '/login',
  '/register',
  '/about',
  // Note: No need to add '/api/auth' here as the handleAuth middleware
  // will process those requests before this middleware runs
]);

// Create auth hooks
const { handleAuth, isAuthenticated: isAuthenticatedPromise } = createConvexAuthHooks();

// Custom handle function for auth-first pattern
const authFirstPattern: Handle = async ({ event, resolve }) => {
  // Skip auth check for public routes
  if (isPublicRoute(event.url.pathname)) {
    return;
  }
  
  // For all other routes, check authentication
  const isAuthenticated = await isAuthenticatedPromise(event);
  if (!isAuthenticated) {
    // Store the original URL for redirect after login
    const returnUrl = encodeURIComponent(event.url.pathname + event.url.search);
    return redirect(307, `/login?redirectTo=${returnUrl}`);
  }
  
  // User is authenticated, continue to next handler
  return resolve(event);
}
```

#### Example 2: Public-first approach (blacklist pattern)
 Most routes are public, only protect specific areas
```ts
const isProtectedRoute = createRouteMatcher([
  '/admin/*path',
  '/dashboard/*path',
  '/profile/*path',
]);
```


```ts
// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks';
import { redirect, type Handle } from '@sveltejs/kit';
import { 
  createConvexAuthHooks, 
  createRouteMatcher 
} from '@convex-dev/auth/sveltekit/server';

const isProtectedRoute = createRouteMatcher([
  '/admin/*path',
  '/dashboard/*path',
  '/profile/*path',
]);

// Create auth hooks
const { handleAuth, isAuthenticated: isAuthenticatedPromise } = createConvexAuthHooks();

// Custom handle function for public-first pattern
const publicFirstPattern: Handle = async ({ event, resolve }) => {
  // Check auth only for protected routes
  if (isProtectedRoute(event.url.pathname)) {
    const isAuthenticated = await isAuthenticatedPromise(event);
    
    if (!isAuthenticated) {
      // Store the original URL for redirect after login
    const returnUrl = encodeURIComponent(event.url.pathname + event.url.search);
    return redirect(307, `/login?redirectTo=${returnUrl}`);
    }
  }
  
  // All other routes are public, or user is authenticated
  return resolve(event);
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

### Option 2: Using Page Server Load (Page-level Protection)

Protect individual pages in their `+page.server.ts`:

```ts
// src/routes/protected/+page.server.ts
import { redirect } from '@sveltejs/kit';
import { createConvexAuthHandlers } from '@convex-dev/auth/sveltekit/server';

const { isAuthenticated: isAuthenticatedPromise } = createConvexAuthHandlers();

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
  
  const isAuthenticated = $derived(useAuth().isAuthenticated);
  const isLoading = $derived(useAuth().isLoading);
</script>

{#if isLoading}
  <p>Loading...</p>
{:else if isAuthenticated}
  <p>You are signed in!</p>
{:else}
  <p>Not signed in.</p>
{/if}
```

### Debug Mode

Enable debug logging by setting an environment variable:

```
CONVEX_AUTH_DEBUG=true
```

This will output detailed logs about auth operations to help with troubleshooting.
