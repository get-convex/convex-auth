# Convex Auth — Next.js SSR example

A minimal Next.js App Router app showing server-side auth with Convex Auth:

- **Middleware** (`middleware.ts`) refreshes the session on navigation and gates
  routes (`/signin` when signed out, `/` when signed in).
- **Route handler** (`app/api/auth/route.ts`) lets the client refresh / sign out
  without ever seeing the refresh token — it lives in an httpOnly cookie.
- **SSR preload** (`app/page.tsx`) reads the access token on the server with
  `convexAuthNextjsToken()` and `preloadQuery`s an authenticated query, so the
  first paint already shows the user.
- **Providers** (`app/layout.tsx`) — `ConvexAuthNextjsServerProvider` seeds the
  client so the browser hydrates already authenticated.

All the server wiring is configured once in `convexAuth.tsx`.

## Run

```sh
npx convex dev      # in one terminal: starts the local backend + pushes functions
pnpm dev            # in another: starts Next.js on http://localhost:3000
```

Uses the **anonymous** provider, so signing in is a single click.
