# Convex Auth — Next.js (App Router) SSR example

Server-side sign-in with Convex Auth — username/password or anonymous: the
refresh token is minted straight into an httpOnly cookie and **never reaches
client JS**. The browser holds only the access token.

## How it works

- **Sign-up / sign-in / refresh / sign-out run on the server** as
  framework-agnostic `(Request) => Response` handlers, mounted under
  `app/auth/`:
  - `app/auth/signin/password/route.ts` → `signInHandler(passwordSignIn(…))`
  - `app/auth/signup/password/route.ts` → `signInHandler(passwordSignUp(…))`
  - `app/auth/signin/anonymous/route.ts` → `signInHandler(anonymous(…))`
  - `app/auth/refresh/route.ts` → `refreshHandler`
  - `app/auth/signout/route.ts` → `signOutHandler`
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
