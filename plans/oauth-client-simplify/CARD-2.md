# Card 2 of 5. Add createNextjsAuthClient and pass both clients to the Next.js provider

One commit in a five-commit series on branch `oauth-client-simplify` in `get-convex/convex-auth`. The series moves auth client construction out of React, gives provider hooks one `useAuthClient()` hook, deletes the ambient sign-in plugin registry, and rebuilds OAuth as plain functions plus thin hooks. This card covers only commit 2. Card 1 is on the branch. Do not start the later commits (OAuth rewrite, provider component cleanup, `expectAuth` support).

Branch setup. `git fetch origin oauth-client-simplify && git checkout oauth-client-simplify && git pull --ff-only origin oauth-client-simplify`. Never push to `reboot`. Do not open a PR.

Read `AGENTS.md` at the repo root first. Relative imports in `packages/core/src` carry the on-disk extension (`./client.tsx`). Paths below are relative to `packages/core/src` unless they start with `examples/`.

## Working style, to keep your context small

- Read only the files named here, and use grep for call sites. Read the harness part of a test file and the tests you change, not the whole file.
- While iterating, run single test files with `pnpm vitest run packages/core/src/<file>`. Run the full `pnpm lint`, `pnpm -r --filter=!argon2id-wasm typecheck`, `pnpm build`, and `pnpm test` once, before committing.
- Do not paste whole files into your reasoning. Do not fetch any URL.

## Writing rules for code comments, tsdoc, test names, and the commit message

- Plain declarative sentences. Short. No em-dashes. No semicolons or colons inside a sentence.
- No metaphors. Say the literal thing. Banned examples include parked, stashed, in flight, kicks off, torn down, latch, gate, plumbed, threaded through, slot, and code that keeps, holds, carries, owns, pins, honors, or proves something. Say stores, uses, sets, checks, passes.
- Describe only the present. Never write still, now, no longer, used to, instead of, or as before in a comment or doc.
- Clauses after a noun keep their "that" or "which". Use short noun phrases ("the sign-in API"). No fragment-then-colon openers.
- A comment is one short sentence by default. Describe a layer once, at one place.
- The commit title is a short imperative phrase.

## State of the branch after card 1 (verify against the head commit, the branch wins where they differ)

- `browser/sessionManager.ts`: `AuthClient` has `setSignInApi(api)`, `readonly signIn` (forwards to the set API, throws a clear error when none is set), `signInStorage(id)`, and `init(options?: { initialAccessToken?: string | null })`. The constructor config is `{ mode, authApi, storage, storageNamespace, ambientSignIns?: ReadonlyArray<AmbientSignInClient>, verbose? }`. The ssr mode `authApi` is `SsrAuthApi = { refreshSession: () => Promise<SlimTokenBundle | null>; signOut: () => Promise<void> }`.
- `browser/createAuthClient.ts`: `createAuthClient(options)` for the SPA. Mirror its structure.
- `browser/retry.ts`: `retryOnNetworkError(fn, log?)` retries fetch failures with a short backoff. `fetchAccessToken` uses it in both modes.
- `react/client.tsx`: `AuthProvider({ authClient, initialAccessToken?, children })`, `useAuthClient()`, `useAuth()`.
- `nextjs/index.tsx`: `ConvexAuthNextjsProvider({ client?, convexUrl?, initialToken, refreshRoute, signOutRoute, signInRoute, storage, children })`. Inside `useMemo` it builds `convex` (from `client` or `convexUrl` or `NEXT_PUBLIC_CONVEX_URL`), an ssr-mode `AuthClient` with `postAuth(route)` for refresh and sign-out, a proxy `new ConvexHttpClient(`${signInRoute}?path=`, { skipConvexDeploymentUrlCheck: true, logger: convex.logger })`, a `withAuth()` helper that calls `proxy.setAuth(token)` or `proxy.clearAuth()` from `authClient.getAccessToken()` before each call, and calls `authClient.setSignInApi({ mutation, action })`. It renders `<AuthProvider authClient initialAccessToken={initialToken}><ConvexProviderWithAuth client={convex} useAuth={useAuth}>`. The module tsdoc explains the proxy and the cookie.
- `nextjs/server.tsx`: `setupConvexAuthNextjs(config)` returns `convexAuthNextjsProxy`, `nextjsProxyRedirect`, `convexAuthNextjsAccessToken`, `isAuthenticatedNextjs`, and `ConvexAuthNextjsServerProvider`. The last one is an async Server Component that awaits `convexAuthNextjsAccessToken()`, lazily imports `./index.tsx`, and renders `<ConvexAuthNextjsProvider convexUrl={config.convexUrl} initialToken={initialToken}>`.
- `examples/nextjs/src/lib/convexAuth.tsx` destructures those five from `setupConvexAuthNextjs({ convexUrl, refreshSession, isAuthenticated })`. `examples/nextjs/app/layout.tsx` renders `<ConvexAuthNextjsServerProvider>{children}</ConvexAuthNextjsServerProvider>`. `examples/nextjs/README.md` describes the setup.
- There is no test file under `nextjs/`.

## Target of this commit

```ts
// @convex-dev/auth/nextjs, called from a "use client" file at module scope
const auth = createNextjsAuthClient({ url, refreshRoute?, signOutRoute?, signInRoute?, storage?, storageNamespace?, logger?, verbose? });
<ConvexAuthNextjsProvider client={convex} auth={auth} initialToken={token}>…</ConvexAuthNextjsProvider>
```

The sign-in API is set at construction by the factory. The provider never calls `setSignInApi`. Refresh and sign-out post to the host routes. Sign-in posts to the proxy route.

## Rules that must hold

1. `ConvexAuthNextjsProvider` never calls `setSignInApi`. `createNextjsAuthClient` sets the proxy client at construction.
2. A Server Component cannot pass a class instance to a Client Component. So no Server Component in this package renders `ConvexAuthNextjsProvider`. The app does it from its own `"use client"` file and passes `initialToken`, a string or null.
3. The per-call token attach stays. A sign-in function may read the current identity, for example to link an account to the signed-in user.
4. Only a function that returns the shared sign-in envelope goes through `auth.signIn`. The proxy returns 500 for any other result (`server/signInProxy.ts`, `classifyResult`). State this once in the factory tsdoc.

## Steps

`nextjs/index.tsx`

- Add `export type CreateNextjsAuthClientOptions = { url: string; refreshRoute?: string; signOutRoute?: string; signInRoute?: string; storage?: TokenStorage; storageNamespace?: string; logger?: Logger; verbose?: boolean }` with defaults `/auth/refresh`, `/auth/signout`, `/auth/signin`, `defaultStorage()`, and `storageNamespace ?? url`.
- Add `export function createNextjsAuthClient(options): AuthClient`. Build the ssr-mode `AuthClient` with `refreshSession: async () => (await postAuth(refreshRoute)).tokens` and `signOut: async () => { await postAuth(signOutRoute); }`. Build the proxy `ConvexHttpClient` and the `withAuth()` helper as the component does today. Set the sign-in API with `auth.setSignInApi({ mutation: (fn, args) => retryOnNetworkError(() => withAuth().mutation(fn, args)), action: (fn, args) => retryOnNetworkError(() => withAuth().action(fn, args)) })`. Import `retryOnNetworkError` from `../browser/retry.ts`. Move the proxy explanation from the component onto the factory tsdoc, once.
- `ConvexAuthNextjsProvider({ client, auth, initialToken = null, children })` with `client: ConvexReactClient` and `auth: AuthClient`. It renders `<AuthProvider authClient={auth} initialAccessToken={initialToken}><ConvexProviderWithAuth client={client} useAuth={useAuth}>`. Remove the `useMemo`, the `convexUrl`, route, and storage props, and the `process.env` read.
- Exports: `createNextjsAuthClient`, `type CreateNextjsAuthClientOptions`, `ConvexAuthNextjsProvider`, `useAuthClient`, `useAuthActions`, `useAuthToken`, the Convex re-exports (`useConvexAuth`, `Authenticated`, `Unauthenticated`, `AuthLoading`), and the `AuthClient` type.
- Rewrite the module tsdoc so the example is a `"use client"` file that builds `convex` and `auth` at module scope and a layout that passes `initialToken`.

`browser/retry.ts`

- Update the module tsdoc. It serves `fetchAccessToken` in both modes and the Next.js proxy sign-in API. Do not change the code.

`nextjs/server.tsx`

- Remove `ConvexAuthNextjsServerProvider` from the returned object, its function, the lazy import of `./index.tsx`, and the `ReactNode` import if nothing else uses it. Remove it from the tsdoc example on `setupConvexAuthNextjs`.
- Add to the module tsdoc the client wiring pattern (rule 2) with a short example of the `"use client"` provider file and an async root layout that awaits `convexAuthNextjsAccessToken()`.

`examples/nextjs`

- Add `src/lib/ConvexClientProvider.tsx`:
  ```tsx
  "use client";
  import { ConvexReactClient } from "convex/react";
  import {
    ConvexAuthNextjsProvider,
    createNextjsAuthClient,
  } from "@convex-dev/auth/nextjs";
  import type { ReactNode } from "react";

  const url = process.env.NEXT_PUBLIC_CONVEX_URL!;
  const convex = new ConvexReactClient(url);
  const auth = createNextjsAuthClient({ url });

  export function ConvexClientProvider({
    initialToken,
    children,
  }: {
    initialToken: string | null;
    children: ReactNode;
  }) {
    return (
      <ConvexAuthNextjsProvider
        client={convex}
        auth={auth}
        initialToken={initialToken}
      >
        {children}
      </ConvexAuthNextjsProvider>
    );
  }
  ```
- `app/layout.tsx` becomes `export default async function RootLayout(...)`, awaits `convexAuthNextjsAccessToken()`, and renders `<ConvexClientProvider initialToken={token}>`.
- Remove `ConvexAuthNextjsServerProvider` from the destructure in `src/lib/convexAuth.tsx` and update the comment above it.
- Update `examples/nextjs/README.md` where it names the server provider.

## Tests

`nextjs/index.test.tsx` (new, `// @vitest-environment jsdom`)

- Stub `globalThis.fetch` with `vi.stubGlobal`. Return `Response.json(...)` bodies in the `ConvexHttpClient` wire format for proxy calls (`{ status: "success", value: ... }`) and `{ tokens: ... }` for the two host routes. Look at `server/signInProxy.ts` and the convex `ConvexHttpClient` source for the exact shapes before writing them.
- `auth.signIn.mutation(ref, { a: 1 })` posts to `/auth/signin?path=/api/mutation` with a JSON body whose `path` is the function name and whose `args` is `[{ a: 1 }]`.
- After `auth.setSession({ accessToken: "jwt", accessTokenExpiresAt: ..., userId: ... })` (a `SlimTokenBundle`, see `lib/types.ts`), the next sign-in call carries `Authorization: Bearer jwt`. Before that, no `Authorization` header.
- `fetchAccessToken({ forceRefreshToken: true })` posts to `/auth/refresh` and `signOut()` posts to `/auth/signout`.
- A first `fetch` that rejects with the error shape `retry.ts` treats as a network error, followed by a success, resolves to the success. Use fake timers if the backoff is long.
- `storageNamespace` defaults to `url` (write a session, then read `storage.getItem` for the namespaced key, or check `signInStorage("x").set` lands under the expected key).
- Render `<ConvexAuthNextjsProvider client={new ConvexReactClient("https://happy-animal-123.convex.cloud")} auth={auth} initialToken="jwt">` with a child that reads `useAuthToken()`. After init the token is `"jwt"`. Spy on `auth.setSignInApi` and assert the provider never calls it (rule 1).

## Verification, then commit and push

```sh
pnpm install
pnpm lint
pnpm -r --filter=!argon2id-wasm typecheck
pnpm build
pnpm test
```

All must pass, including the `examples/nextjs` typecheck. Commit once with the title `Add createNextjsAuthClient and pass the clients to the Next.js provider` and a body that names the removed `ConvexAuthNextjsServerProvider` and the `ConvexClientProvider` pattern. Push with `git push -u origin oauth-client-simplify`.

## Final message

List the files you changed, the tests you added, anything you did differently from this card and why, and anything the next card has to know. Do not write the next card yourself.

Write the same report to `plans/oauth-client-simplify/report-2.md` and include it in your commit, so the next planner session can read it from the branch.
