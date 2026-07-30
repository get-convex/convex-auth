# Convex Auth — Next.js (App Router) SSR example

Server-side sign-in with Convex Auth: the refresh token is minted straight into
an httpOnly cookie and **never reaches client JS**. The browser holds only the
access token.

## How it works

- **Sign-in / refresh / sign-out run on the server** as framework-agnostic
  `(Request) => Response` handlers, mounted under `app/auth/`:
  - `app/auth/signin/anonymous/route.ts` → `anonymousSignInHandler`
  - `app/auth/refresh/route.ts` → `refreshHandler`
  - `app/auth/signout/route.ts` → `signOutHandler`
- **`src/lib/convexAuth.tsx`** wires the Next-specific helpers via
  `setupConvexAuthNextjs`: the proxy (up-front refresh + redirects, mounted in
  `proxy.ts`), the Server-Component token accessor
  `convexAuthNextjsAccessToken`, and `ConvexAuthNextjsServerProvider`
  (hydrates the client from the cookie).
- **`app/signin/page.tsx`** uses the SSR sibling hook `useAnonymousAuth()` from
  `@convex-dev/auth/nextjs`, which POSTs to the sign-in route and adopts the
  access-only session it returns.

## Run it

```sh
cd examples/nextjs
npx convex dev --once   # provisions a deployment, generates convex/_generated
npx @convex-dev/auth    # sets AUTH_PRIVATE_KEY + AUTH_JWKS on the deployment
npx convex dev          # push functions + keep them in sync (one terminal)
npm run dev             # next dev (another terminal)
```

Then open http://localhost:3000 — you'll be redirected to `/signin`.
