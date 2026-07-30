# Convex Auth — Next.js (App Router) SSR example

Server-side sign-in with Convex Auth — username/password or anonymous: the
refresh token is minted straight into an httpOnly cookie and **never reaches
client JS**. The browser holds only the access token.

## How it works

- **Sign-up / sign-in / refresh / sign-out run on the server** as
  framework-agnostic `(Request) => Response` handlers, all served by one
  catch-all route, `app/auth/[...convexAuth]/route.ts`. The route table is
  configured once in `src/lib/serverAuth.ts`: `setupConvexAuthServer` mounts
  the built-in `refresh` and `signout` routes plus each provider's sign-in
  routes (`passwordRoutes` registers `signin/password` and `signup/password`,
  `anonymousRoutes` registers `signin/anonymous`).
- **`src/lib/convexAuth.tsx`** wires the Next-specific helpers via
  `setupConvexAuthNextjs`: the proxy (up-front refresh + redirects, mounted in
  `proxy.ts`), the Server-Component token accessor
  `convexAuthNextjsAccessToken`, and `ConvexAuthNextjsServerProvider`
  (hydrates the client from the cookie).
- **`app/signin/page.tsx` / `app/signup/page.tsx`** use the SSR sibling hooks
  `useSignInWithPassword()` / `useSignUpWithPassword()` from
  `@convex-dev/auth/nextjs`, which POST the credentials to the routes above and
  adopt the access-only session they return. On failure, the route echoes the
  action's `userError` (e.g. `INVALID_CREDENTIALS`, `USERNAME_TAKEN`) so the
  form can show a specific message. The sign-in page also offers
  `useAnonymousAuth()`'s one-click anonymous sign-in.

## Run it

```sh
cd examples/nextjs
npx convex dev --once   # provisions a deployment, generates convex/_generated
npx @convex-dev/auth    # sets AUTH_PRIVATE_KEY + AUTH_JWKS on the deployment
npm run dev             # runs Convex and next dev together
```

Then open <http://localhost:3000> — you'll be redirected to `/signin`; create an
account at `/signup`.
