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

Set up the Convex client and auth provider in your root layout:

```html
<!-- src/routes/+layout.svelte -->
<script>
  import { PUBLIC_CONVEX_URL } from '$env/static/public';
  import { setupConvex } from 'convex-svelte';
  import { createSvelteKitAuthProvider } from '@convex-dev/auth/sveltekit';
  
  // Initialize the Convex client
  setupConvex(PUBLIC_CONVEX_URL);
  
  // Import data from +layout.server.ts 
  export let data;
  
  // Create auth provider component
  const AuthProvider = createSvelteKitAuthProvider();
</script>

<AuthProvider serverState={data.authState}>
  <slot />
</AuthProvider>
```

### 3. Add Auth State in Layout Server

Load the authentication state in your layout server:

```typescript
// src/routes/+layout.server.ts
import { createConvexAuthHandlers } from '@convex-dev/auth/sveltekit/server';
import { PUBLIC_CONVEX_URL } from '$env/static/public';
import type { LayoutServerLoad } from './$types';

// Create auth handlers
const { loadAuthState } = createConvexAuthHandlers({
  convexUrl: PUBLIC_CONVEX_URL
});

// Export load function to provide auth state to layout
export const load: LayoutServerLoad = async (event) => {
  return loadAuthState(event);
};
```

### 4. Configure Auth Hooks (Server-side)

Create hooks to handle authentication in `src/hooks.server.ts`:

```typescript
// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks';
import { PUBLIC_CONVEX_URL } from '$env/static/public';
import { createConvexAuthHooks } from '@convex-dev/auth/sveltekit/server';

// Create auth hooks with your Convex URL
const { handleAuth, protectRoutes } = createConvexAuthHooks({
  convexUrl: PUBLIC_CONVEX_URL,
  // Optional: Custom API route (default: '/api/auth')
  apiRoute: '/api/auth', 
  // Optional: Custom cookie options
  cookieOptions: {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax'
  }
});

// Apply hooks in sequence
export const handle = sequence(
  handleAuth,  // This handles all POST requests to /api/auth automatically
  protectRoutes,
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
import { PUBLIC_CONVEX_URL } from '$env/static/public';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Create auth handlers
const { isAuthenticated } = createConvexAuthHandlers({
  convexUrl: PUBLIC_CONVEX_URL
});

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
  convexUrl: PUBLIC_CONVEX_URL,
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
import { PUBLIC_CONVEX_URL } from '$env/static/public';

const { isAuthenticated } = createConvexAuthHandlers({
  convexUrl: PUBLIC_CONVEX_URL
});

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

```svelte
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

```svelte
<script>
  import { useAuth } from '@convex-dev/auth/svelte';
  
  const { signOut } = useAuth();
  
  function handleSignOut() {
    signOut();
  }
</script>
```

### Check Auth State

```svelte
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
  convexUrl: PUBLIC_CONVEX_URL,
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

```svelte
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
import { PUBLIC_CONVEX_URL } from '$env/static/public';
import type { RequestHandler } from '@sveltejs/kit';

// Create auth handlers
const { handleAuthAction } = createConvexAuthHandlers({
  convexUrl: PUBLIC_CONVEX_URL
});

// Export POST handler for auth requests
export const POST: RequestHandler = handleAuthAction;
```

When using this approach, make sure to update your Auth Provider to use the same API route:

```svelte
<AuthProvider apiRoute="/api/auth" serverState={data.authState}>
  <slot />
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
