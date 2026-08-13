# Convex Auth — Next.js (App Router) SSR example

Server-side sign-in with Convex Auth: the refresh token is minted straight into
an httpOnly cookie and **never reaches client JS**. The browser holds only the
access token.

## How it works

- **Sign-in / refresh / sign-out run on the server** as framework-agnostic
  `(Request) => Response` handlers, mounted under `app/auth/`:
  - `app/auth/signin/route.ts` → `convexProxyHandler`, the one route serving
    every sign-in method
  - `app/auth/refresh/route.ts` → `refreshHandler`
  - `app/auth/signout/route.ts` → `signOutHandler`
- **The sign-in route** speaks the same HTTP interface as `ConvexHttpClient` and
  forwards calls to the deployment, intercepting only the minted refresh token
  on the way back to put it in the cookie. Because of that, a provider needs no
  SSR-specific client hook: `app/signin/page.tsx` imports the _same_
  `useAnonymousAuth` a SPA would, from
  `@convex-dev/auth/providers/anonymous/react`.
- **Adding an auth method** means adding its function to `signIn` in
  `src/lib/serverAuth.ts`. That allowlist is the route's entire API surface;
  there is no per-method route and no per-method client code.
- **`src/lib/convexAuth.tsx`** wires the Next-specific helpers via
  `setupConvexAuthNextjs`: the proxy (up-front refresh + redirects, mounted in
  `proxy.ts`), the Server-Component token accessor
  `convexAuthNextjsAccessToken`, and `ConvexAuthNextjsServerProvider`
  (hydrates the client from the cookie).

## Run it

```sh
cd examples/nextjs
npx convex dev --once   # provisions a deployment, generates convex/_generated
npx @convex-dev/auth    # sets AUTH_PRIVATE_KEY + AUTH_JWKS on the deployment
npm run dev             # runs Convex and next dev together
```

Then open <http://localhost:3000> — you'll be redirected to `/signin`.
