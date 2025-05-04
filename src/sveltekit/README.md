# Convex Auth for SvelteKit

This package provides authentication functionality for SvelteKit applications using Convex as a backend. It includes both client-side components and server-side utilities for a complete authentication solution.

## Table of Contents

- [Installation](#installation)
- [Setup](#setup)
  - [1. Environment Variables](#1-environment-variables)
  - [2. Run the initialization command](#2-run-the-initialization-command)
  - [3. Initialize Auth (Client-side)](#3-initialize-auth-client-side)
  - [4. Add Auth State in Layout Server](#4-add-auth-state-in-layout-server)
  - [5. Configure Auth Hooks (Server-side)](#5-configure-auth-hooks-server-side)
- [Usage](#usage)
  - [Pages (`+page.svelte`)](#pages-pagesvelte)
  - [Page Server (`+page.server.ts`)](#page-server-pageserverts)
- [Protecting Routes](#protecting-routes)
  - [Option 1: Using Hooks (App-wide Protection) (Recommended)](#option-1-using-hooks-app-wide-protection-recommended)
  - [Option 2: Using Page Server Load (Page-level Protection)](#option-2-using-page-server-load-page-level-protection)
- [Authentication Actions](#authentication-actions)
  - [Sign In](#sign-in)
  - [Sign Out](#sign-out)
  - [Check Auth State](#check-auth-state)
- [Debug Mode](#debug-mode)
- [Making Authenticated Requests](#making-authenticated-requests)
  - [Server-side Requests](#server-side-requests)
  - [Client-side Requests](#client-side-requests)

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
  
  // Set up authentication (automatically initializes Convex client)
  setupConvexAuth({ serverState: () => data.authState });
  
  // Alternatively, you have these options:
  
  // Option 1: Provide a custom Convex URL
  // setupConvexAuth({
  //   serverState: () => data.authState,
  //   convexUrl: "https://your-convex-deployment.convex.cloud"
  // });
  
  // Option 2: Provide your own ConvexClient instance
  // import { ConvexClient } from "convex/browser";
  // const client = new ConvexClient("https://your-deployment.convex.cloud");
  // setupConvexAuth({ serverState: () => data.authState, client });
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
    // Redirect to signin if not authenticated
    throw redirect(302, '/signin');
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
  '/signin',
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
  '/signin',
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
    // Store the original URL for redirect after signin
    const returnUrl = encodeURIComponent(event.url.pathname + event.url.search);
    return redirect(307, `/signin?redirectTo=${returnUrl}`);
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
      // Store the original URL for redirect after signin
    const returnUrl = encodeURIComponent(event.url.pathname + event.url.search);
    return redirect(307, `/signin?redirectTo=${returnUrl}`);
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
    throw redirect(302, '/signin?redirectTo=' + event.url.pathname);
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

## Making Authenticated Requests

One of the key benefits of Convex Auth is the ability to make authenticated requests to your Convex backend. This section explains how to perform authenticated requests both on the server and client sides.

### Server-side Requests

The `createConvexHttpClient` function provided by the server handlers allows you to create an authenticated HTTP client for making server-side requests to your Convex backend.

```ts
// src/routes/some-page/+page.server.ts
import type { PageServerLoad } from './$types';
import { api } from '$lib/convex/_generated/api.js';
import { createConvexAuthHandlers } from '@convex-dev/auth/sveltekit/server';

export const load = (async (event) => {
  const { createConvexHttpClient } = createConvexAuthHandlers();
  
  // Create an authenticated HTTP client
  // If the user is authenticated, this client will have the auth token
  // If not, it will be an unauthenticated client
  const client = await createConvexHttpClient(event);

  // Make authenticated queries to your Convex backend
  const viewer = await client.query(api.users.viewer, {});
  
  return { viewer };
}) satisfies PageServerLoad;
```

The `createConvexHttpClient` function automatically:
- Creates a Convex HTTP client using the Convex URL (automatically detected from environment variables)
- Sets the authentication token if the user is signed in
- Returns an unauthenticated client if the user is not signed in

You can then use this client to make authenticated queries and mutations to your Convex backend.

### Client-side Requests

On the client side, you can use the Convex Svelte integration to make authenticated requests. The authentication is handled automatically when you set up Convex Auth as described in the setup section.

```html
<!-- src/routes/some-page/+page.svelte -->
<script lang="ts">
  import { api } from '$lib/convex/_generated/api';
  import { useQuery, useConvexClient } from 'convex-svelte';

  // Get data from +page.server.ts (initial loading)
  let { data } = $props();

  // Make an authenticated query
  // The initial data comes from the server for faster rendering
  const viewer = useQuery(api.users.viewer, {}, () => ({
    initialData: data.viewer
  }));

  // Get Convex client for mutations
  const client = useConvexClient();
  
  // Example message state
  let messageText = $state('');

  // Function to handle sending a message using mutation
  async function handleSend(event) {
    event.preventDefault();
    if (messageText.trim() === '') return;
    
    try {
      // Execute the mutation directly using the client
      await client.mutation(api.messages.send, { body: messageText });
      messageText = '';
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  }
</script>

{#if viewer.data}
  <div>
    <h1>Welcome, {viewer.data.name}!</h1>
    
    <!-- Message form example -->
    <form on:submit={handleSend} class="flex gap-2 p-4">
      <input type="text" bind:value={messageText} placeholder="Write a message..." class="input" />
      <button type="submit" disabled={messageText === ''} class="btn">
        Send
      </button>
    </form>
  </div>
{/if}
```

This approach:
- Uses `useQuery` from Convex Svelte to make authenticated queries
- Leverages server-side data as initial data for a smoother user experience
- Uses `useConvexClient()` to get the Convex client for making mutations
- Calls `client.mutation()` directly to execute mutations

By combining server-side and client-side authenticated requests, you can create a seamless authentication experience while optimizing for performance and user experience.
