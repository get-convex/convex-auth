# Simplify the Convex Auth v2 client: factory, setter, no plugin registry

Repo `get-convex/convex-auth`, base branch `reboot` (HEAD `78bc044` when this plan was written). Work on branch `oauth-client-simplify`. Create it from `origin/reboot` if it does not exist. Never push to `reboot`. Do not open a PR unless asked.

Read `AGENTS.md` at the repo root first. It has the import rules (relative imports in `packages/core/src` carry the on-disk extension, `./client.tsx`), the build layout, and the commands.

## Writing rules for everything you write (code comments, tsdoc, test names, commit messages)

- Plain declarative sentences. Short. No em-dashes. No semicolons or colons inside a sentence.
- No metaphors. Say the literal thing. Banned examples: parked, stashed, in flight, kicks off, torn down, latch, gate, drained, bubbles up, plumbed, threaded through, slot, and code that keeps, holds, carries, owns, pins, honors, or proves something. Say stores, uses, sets, checks, passes.
- Describe only the present. Never write still, now, no longer, used to, instead of, or as before in a comment or doc. Give the reason that holds today, not the change that produced it.
- Clauses after a noun keep their "that" or "which". Name things with short noun phrases ("the sign-in API", "the pending flow record"). No fragment-then-colon openers.
- A comment is one short sentence by default. Describe a layer once, at one place. Comments describe only the code next to them.
- Commit titles are short imperative phrases.

## Goal

Make the auth client a plain object that the app builds outside React and passes to the provider, give provider code one hook that returns the whole client, delete the ambient sign-in plugin system, and rebuild OAuth as plain functions plus thin hooks. Transports do not change. Sign-in mutations in a single-page app go over the app's `ConvexReactClient` websocket, refresh and sign-out use the auth client's own `ConvexHttpClient`, and under Next.js sign-in goes through the SSR sign-in proxy. The backend does not change.

Background article (optional): https://claude.ai/artifact/651sDBwNnvMad6eo3MHESU

## Current code you are changing

- `packages/core/src/browser/sessionManager.ts` is the `AuthClient` class (framework free, `subscribe`, `getSnapshot`, `init`, `dispose`, `setSession`, `withSignInPending`, `signOut`, `fetchAccessToken`). Its constructor takes `{ mode: "spa" | "ssr", authApi, storage, storageNamespace, initialAccessToken?, ambientSignIns?, verbose? }` and runs ambient sign-in setups.
- `packages/core/src/browser/ambientSignInClient.ts` (types `AuthSignInApi`, `AmbientSignInClient`, `AmbientSignInContext`), `browser/keyedStore.ts` (`KeyedStore`), `react/providers.ts` (`useAmbientSignInValue`) are the plugin system. One plugin exists, `oauth()` in `oauth/client.ts`.
- `packages/core/src/react/index.tsx` builds the `AuthClient` inside `useMemo` from provider props `client, api, storage, storageNamespace, ambientSignIns` and builds a `signInApi` wrapper over the Convex client. `react/client.tsx` has `AuthProvider`, `useAuth`, `useAuthSignInApi`, `AuthClientContext`, `ConvexAuthActionsContext`, `ConvexAuthTokenContext`.
- `packages/core/src/nextjs/index.tsx` builds an ssr-mode `AuthClient` and a `ConvexHttpClient` pointed at `${signInRoute}?path=` as the sign-in API, with a per-call `withAuth()` that sets or clears the access token. `nextjs/server.tsx` exports `setupConvexAuthNextjs`, whose `ConvexAuthNextjsServerProvider` (a Server Component) renders `ConvexAuthNextjsProvider` with `convexUrl` and `initialToken`.
- `packages/core/src/oauth/client.ts` has the `oauth()` plugin with `signIn`, `completeFlow`, `handleCallback`, the pending flow record, and the flow error codes. `oauth/react.ts` has `useOauth`, `useOauthSignIn`, `useSignInWithGoogle/Apple/Github` reading the keyed store.
- Provider hooks that read the current surface: `components/passkey/react.tsx` and `flows.ts` (`SignInFlowContext`, a `ctxRef` built from four hooks), `components/email/react.tsx` (`useSecretStorage`, `useWithSignInPending`, `useLinkFlow`, `useSignInWithEmailPassword`, `useSignUpWithEmailPassword`, `useCompleteSignUp`), `components/password/react.tsx`, `components/anonymous/react.tsx`.
- `packages/core/src/server/signInProxy.ts` `classifyResult` returns 500 for any function result that is not the shared sign-in envelope (`{ status: "complete", tokens }` or `{ status: "error", userError }`).
- `packages/core/src/browser/retry.ts` `retryOnNetworkError` is used by `fetchAccessToken` (both modes) and by OAuth completion.
- Examples: `examples/react-*/src/main.tsx` render `ConvexAuthProvider`. `examples/nextjs/src/lib/convexAuth.tsx` calls `setupConvexAuthNextjs` and `app/layout.tsx` renders `ConvexAuthNextjsServerProvider`. `examples/react-github|google|apple/src/App.tsx` use `useOauth` and a per-provider hook.
- Public entry points in `packages/core/package.json`: `./browser`, `./react`, `./nextjs`, `./nextjs/server`, `./server`, `./providers/oauth/react`, `./providers/passkey/react`, plus `./providers/password/*`, `./providers/anonymous/*`, `./providers/email/*` by wildcard.

## Target API

```ts
// @convex-dev/auth/browser and re-exported from @convex-dev/auth/react
const auth = createAuthClient({
  url,                     // deployment URL
  api,                     // { refreshSession, signOut } mutation refs (ConvexAuthApi)
  storage?,                // TokenStorage, default defaultStorage()
  storageNamespace?,       // default url
  logger?,                 // Logger from convex/browser, passed to the ConvexHttpClient
  verbose?,
  signInApi?,              // optional, calls setSignInApi for plain JavaScript callers
});
auth.setSignInApi(api: AuthSignInApi): void;   // the provider calls this
auth.signIn.mutation(ref, args); auth.signIn.action(ref, args);  // forward to the set API, throw a clear error when none is set
auth.signInStorage(id: string): SignInStorage; // auth.signInStorage("oauth"), auth.signInStorage("email")
await auth.init({ initialAccessToken? });       // initialAccessToken moves from the constructor to init

// React (SPA)
<ConvexAuthProvider client={convex} auth={auth}>…</ConvexAuthProvider>
useAuthClient(): AuthClient   // provider code. Throws outside a provider.
useAuthActions(), useAuthToken(), useConvexAuth(), Authenticated, Unauthenticated, AuthLoading  // unchanged

// Next.js (client file, "use client")
const auth = createNextjsAuthClient({ url, refreshRoute?, signOutRoute?, signInRoute?, storage?, storageNamespace?, logger?, verbose? });
<ConvexAuthNextjsProvider client={convex} auth={auth} initialToken={token}>…</ConvexAuthNextjsProvider>

// Plain JavaScript
auth.setSignInApi(convexClient);            // or the signInApi option
convexClient.setAuth((a) => auth.fetchAccessToken(a));
await auth.init();

// OAuth (@convex-dev/auth/providers/oauth/react)
useOauthSignIn(refs): { signIn }     // starts on click, completes a callback on mount
useOauthCallback(): { flowError }    // for a custom redirectTo landing page
useOauth(): { flowError }            // read the flow error from any component
useSignInWithGoogle(api), useSignInWithApple(api), useSignInWithGithub(api)   // thin wrappers, unchanged shape
```

## Rules that must hold

1. Only a function that returns the shared sign-in envelope goes through `auth.signIn`. Anything else is an ordinary Convex call through the `ConvexReactClient` (`useConvex()` in React). The SSR proxy returns 500 for other results. This applies to OAuth `startSignIn` (returns `{ redirect, state }`), passkey `startSignIn` and `startAutofillSignIn`, and email `signUp` (returns `{ success, browserSecret }`).
2. Callback query params (`convexAuthCode`, `convexAuthError` from `lib/oauthParams.ts`) are read and removed from the URL synchronously, before the first `await`, and `window.history.state` is passed back through `replaceState`. A second run sees a clean URL and does nothing.
3. `withSignInPending` must be entered synchronously in a mount effect so the pending count is above zero before `init()` resolves. React runs child effects before parent effects, so a hook rendered inside the provider enters it before `AuthProvider`'s `init()` effect runs. The app must never observe `isLoading: false, isAuthenticated: false` while a completion is in progress.
4. `init()` is idempotent after its first call and re-attaches the storage listener on every call. Keep that.
5. The SPA provider sets the sign-in API during render, not in an effect, because child mount effects call `auth.signIn` before the provider's own effects run. The call is an idempotent assignment.
6. `ConvexAuthNextjsProvider` never calls `setSignInApi`. `createNextjsAuthClient` sets the proxy client at construction.
7. The `AuthClient` must not lose a session when `setSession` runs while `init()` is loading storage. Today `init()` assigns `#accessToken` from a storage read that may predate a concurrent `setSession`. Fix it in the client (see commit 3) and test it.

## Commit 1. Core-first refactor, no behavior change

The ambient system keeps running in this commit, through the new sign-in API.

`browser/sessionManager.ts`

- Add `#signInApi: AuthSignInApi | null = null`, `setSignInApi(api)`, and `readonly signIn: AuthSignInApi` whose `mutation` and `action` forward to `#signInApi` and throw `Error("[convex-auth] No sign-in API is set on this AuthClient. Render it with ConvexAuthProvider or ConvexAuthNextjsProvider, or call setSignInApi(convexClient) first.")` when unset.
- Add `signInStorage(id: string): SignInStorage` returning `this.#storage.forSignIn(id)`. Validate `id` with `/^[a-zA-Z0-9]+$/` and throw on failure (reuse the message from `#registerAmbientSignIns`).
- Change `init()` to `init(options?: { initialAccessToken?: string | null })`. Remove `initialAccessToken` from the config and the `#initialAccessToken` field. The token is written to storage before the load, as today.
- Change the `ambientSignIns` config to `ReadonlyArray<AmbientSignInClient>` (no `signInApi` field). `#registerAmbientSignIns` passes `signInApi: this.signIn` to each setup. Commit 2 deletes all of this.

`browser/createAuthClient.ts` (new, exported from `browser/index.ts`)

- `createAuthClient(options)` per the target API. Builds `new ConvexHttpClient(url, { logger })` for `refreshSession` and `signOut` exactly as `react/index.tsx` does today, constructs the spa-mode `AuthClient`, registers `ambientSignIns ?? [oauth()]` (temporary option, removed in commit 2), and calls `setSignInApi` when `signInApi` is given. Comment why refresh and sign-out use a separate HTTP client (the websocket is paused during the token handshake, so a refresh over it would deadlock). Keep that comment here only.

`react/client.tsx`

- Remove `ConvexAuthSignInApiContext` and `useAuthSignInApi`.
- Add `export function useAuthClient(): AuthClient` reading `AuthClientContext`. Error message names both providers.
- `AuthProvider({ authClient, initialAccessToken?, children })`. The init effect calls `authClient.init({ initialAccessToken })`.
- Keep `useAuthActions` (`setSession`, `signOut`) and `useAuthToken` as they are. Update the `useAuthActions` tsdoc to say provider code uses `useAuthClient()`.

`react/index.tsx`

- `ConvexAuthProvider({ client, auth, children })`. Build the wrapper once per client with `useMemo`: `{ mutation: (fn, args) => client.mutation(fn, args), action: (fn, args) => client.action(fn, args) }`. Call `auth.setSignInApi(wrapper)` during render on every render. One comment states rule 5.
- Remove the `api`, `storage`, `storageNamespace`, `ambientSignIns` props. Export `createAuthClient`, `useAuthClient`, and the `AuthClient` and `AuthSignInApi` types. Remove the `useAuthSignInApi` export. Update the module tsdoc example to build the client with `createAuthClient` at module scope.

`nextjs/index.tsx`

- Add `createNextjsAuthClient(options)` per the target API. It builds the ssr-mode `AuthClient` with the `postAuth` refresh and sign-out functions, builds the proxy `ConvexHttpClient(`${signInRoute}?path=`, { skipConvexDeploymentUrlCheck: true, logger })`, keeps the per-call `withAuth()` token attach, and calls `auth.setSignInApi({ mutation, action })` at construction. Defaults for the three routes stay `/auth/refresh`, `/auth/signout`, `/auth/signin`.
- `ConvexAuthNextjsProvider({ client, auth, initialToken = null, children })` renders `<AuthProvider authClient={auth} initialAccessToken={initialToken}><ConvexProviderWithAuth client={client} useAuth={useAuth}>`. Remove `convexUrl` and the route and storage props. Export `createNextjsAuthClient`, `useAuthClient`, `useAuthActions`, `useAuthToken`, and the Convex re-exports.

`nextjs/server.tsx`

- A Server Component cannot pass class instances to a Client Component, so `ConvexAuthNextjsServerProvider` cannot exist in this shape. Remove it from the object `setupConvexAuthNextjs` returns and from its tsdoc example. The app renders its own client provider file and passes `initialToken` from `convexAuthNextjsAccessToken()`. Document this pattern in the module tsdoc with the example below.

`examples/nextjs`

- Add `src/lib/ConvexClientProvider.tsx` with `"use client"`. At module scope: `const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!)` and `const auth = createNextjsAuthClient({ url: process.env.NEXT_PUBLIC_CONVEX_URL! })`. Export `ConvexClientProvider({ initialToken, children })` rendering `ConvexAuthNextjsProvider`.
- `app/layout.tsx` becomes an async component that awaits `convexAuthNextjsAccessToken()` and renders `<ConvexClientProvider initialToken={token}>`.
- Remove `ConvexAuthNextjsServerProvider` from the destructure in `src/lib/convexAuth.tsx`. Update `examples/nextjs/README.md` where it describes the provider.

SPA examples (`react-minimal`, `react-password`, `react-passkey`, `react-passkey-basic`, `react-github`, `react-google`, `react-apple`)

- `main.tsx` builds `const auth = createAuthClient({ url: import.meta.env.VITE_CONVEX_URL, api: api.auth })` (carry over any `storage` prop an example passes today) and renders `<ConvexAuthProvider client={convex} auth={auth}>`.

Provider hooks, mechanical only in this commit

- `components/password/react.tsx`, `components/anonymous/react.tsx`, `components/passkey/react.tsx`, `components/email/react.tsx`: replace `useAuthSignInApi()` with `useAuthClient().signIn`. Leave the rest for commit 3.

Tests for commit 1

- `react/client.test.tsx`: `AuthProvider` takes no `signInApi`. Add tests for `useAuthClient` (throws outside a provider, returns the client inside), and for `init({ initialAccessToken })`.
- `react/index.test.tsx`: `ConvexAuthProvider` takes `auth`. Rewrite "the sign-in api routes through the Convex client" as `auth.signIn.mutation` reaching `client.mutation`. Add: a child component's mount effect can call `auth.signIn.mutation` (the API is set before child effects run). Add: changing the `client` prop re-sets the API. Add: StrictMode double render is safe.
- `browser/sessionManager.test.ts`: `setSignInApi` and `signIn` forwarding, the unset error, `signInStorage` id validation and key scoping, and move the `initialAccessToken` tests to `init({ initialAccessToken })`. Adapt the ambient describe to the new config shape.
- `browser/createAuthClient.test.ts` (new): refresh and sign-out call the given mutation refs through an HTTP client (stub `fetch`), `storageNamespace` defaults to `url`, `signInApi` option sets the API.
- `nextjs/index.test.tsx` (new, jsdom): `createNextjsAuthClient` posts to the three routes, the sign-in API posts to `${signInRoute}?path=/api/mutation`, and the per-call token attach sends the current access token (stub `fetch`).
- Component tests (`components/{anonymous,password,passkey,email}/react.test.tsx`), `oauth/testFlow.ts` `oauthClient`, and `oauth/react.test.tsx`: call `authClient.setSignInApi(signInApi)` before rendering, render `<AuthProvider authClient={client}>`.

## Commit 2. OAuth rewrite, delete the plugin system

Delete

- `browser/ambientSignInClient.ts`, `browser/keyedStore.ts`, `browser/keyedStore.test.ts`, `react/providers.ts`, `react/providers.test.tsx`.
- In `sessionManager.ts`: the `ambientSignIns` config, `#ambientValues`, `ambientSignInValues()`, `#initCallbacks`, `#registerAmbientSignIns`, and the onInit loop in `init()`. In `createAuthClient.ts`: the `ambientSignIns` option and the `oauth` import. In `browser/index.ts` and `react/index.tsx`: the ambient type exports.
- Move the `AuthSignInApi` type to `browser/signInApi.ts` and update every import. Keep its tsdoc, minus the retry sentence.

`oauth/flowState.ts` (new)

- A per-client flow error store so `useOauth()` works from a component other than the one that ran the callback. `WeakMap<AuthClient, { error: OauthFlowError | null; listeners: Set<() => void> }>` with `getOauthFlowError(auth)`, `setOauthFlowError(auth, error)`, `subscribeOauthFlowError(auth, listener)`. No string keys, no generic store.

`oauth/client.ts` rewrite

- Keep the types `OauthProviderApi`, `OauthProviderRefs`, `OauthFlowErrorCode`, `OauthFlowError`, `SignInOptions`, `SignInOutcome`, `PendingFlow`, plus `SERVER_ERRORS`, `OAUTH_FLOW_STORAGE_KEY`, `currentHref`, `takePendingFlow`, `dropPendingFlow`.
- Remove `oauth()`, `OauthActions`, `OAUTH_ACTIONS_KEY`, `OAUTH_FLOW_ERROR_KEY`, and the `retryOnNetworkError` import. Rename `OAUTH_SETUP_ID` to `OAUTH_STORAGE_ID = "oauth"` (same string, so a flow saved before the upgrade is found).
- Add `export type OauthClientContext = { auth: AuthClient; convex: Pick<AuthSignInApi, "mutation"> }`. `convex` is the ordinary client (rule 1).
- `startOauthSignIn(ctx, refs, options?): Promise<SignInOutcome>`. Today's `signIn` body. `startSignIn` runs through `ctx.convex.mutation`. The pending flow is stored in `ctx.auth.signInStorage(OAUTH_STORAGE_ID)`. With `options.code` it delegates to `completeOauthSignIn` (the React Native path). Flow errors go through `flowState.ts`.
- `completeOauthSignIn(ctx, code): Promise<boolean>`. Today's `completeFlow`. Runs inside `ctx.auth.withSignInPending`, redeems through `ctx.auth.signIn.mutation(completeSignIn, { code, state })`, calls `ctx.auth.setSession`, never rejects.
- `readOauthCallback(): { code: string } | { error: OauthFlowErrorCode } | null`. Synchronous. Today's `handleCallback` URL part (rule 2). Returns null with no page URL.
- `handleOauthCallback(ctx): boolean`. Calls `readOauthCallback()`. On an error param it drops the pending flow and sets the flow error. On a code it calls `void completeOauthSignIn(ctx, code)`, which enters `withSignInPending` synchronously. Returns whether a callback param was present.
- Module tsdoc states rule 1 and rule 2 once.

`oauth/react.ts` rewrite

- `useOauth()`: `useAuthClient()` plus `useSyncExternalStore` over `flowState.ts`. Server snapshot is `null`.
- `useOauthCallback()`: `const auth = useAuthClient(); const convex = useConvex();` and `useEffect(() => { handleOauthCallback({ auth, convex }); }, [auth, convex])`. Returns `useOauth()`.
- `useOauthSignIn(refs)`: calls `useOauthCallback()` internally. `signIn` is memoized on `[auth, convex, providerName, startPath, completePath]` with the existing `getFunctionName` pattern and calls `startOauthSignIn({ auth, convex }, refs, options)`. Returns `{ signIn }`.
- Per-provider hooks unchanged in shape. Remove `NOT_REGISTERED_ERROR` and the `oauth` export. The module tsdoc says the hooks work under `ConvexAuthNextjsProvider` when the provider's `completeSignIn*` function is in the proxy `signIn` allowlist, and that `startSignIn*` runs over the ordinary Convex client.

`nextjs/index.tsx`

- Wrap the proxy sign-in API calls in `retryOnNetworkError` from `browser/retry.ts`. Update the `retry.ts` module tsdoc. It serves `fetchAccessToken` in both modes and the SSR proxy sign-in API.

`KNOWN_ISSUES.md`

- Remove "OAuth isn't wired into the Next.js client". Keep the other OAuth entries and check their file references.

Tests for commit 2

- `oauth/client.test.ts`: rewrite against the new functions, same scenarios. Redeem on callback, removing params keeps history state, never reports signed out during a redeem, a second client on the same URL finds it clean, error param cases, `invalid_flow`, `INVALID_CODE` to `expired`, `ConvexError` to `rejected` with and without a string message, storage read and removal failures, start persists the flow and returns the redirect, start with `code` completes, start clears a previous flow error, failed and rejected starts, foreign `?code=` and `?error=` params are left alone. Assert `startSignIn` ran on the `convex` stub and `completeSignIn` on the `auth.signIn` stub.
- `oauth/clientEnvironment.test.ts`: `readOauthCallback()` returns null and `handleOauthCallback` does nothing with no `window` and with a `window` that has no `location`.
- `oauth/react.test.tsx`: hooks throw outside a provider, StrictMode double mount redeems once, a callback error param reaches `useOauth()` in a sibling component, `useOauthSignIn` starts a flow with the picked refs through the `ConvexProvider` client, per-provider hooks, stable `signIn` identity across rerenders, structural api param. New: with `?convexAuthCode=` in the URL under StrictMode, the auth state never reports `isLoading: false` with `isAuthenticated: false` before `setSession` (rule 3). New: an ssr-mode client whose sign-in API is a stub proxy completes through `auth.signIn` while `startSignIn` goes through the ordinary client.
- `browser/sessionManager.test.ts`: delete the ambient describe. Keep a test that `withSignInPending` entered before `init()` resolves holds `isLoading` past the load.
- `react/index.test.tsx`: remove the ambient tests.
- Update `oauth/testFlow.ts` helpers to the new functions.

## Commit 3. Provider components use the client

`components/passkey/flows.ts` and `react.tsx`

- `SignInFlowContext = { auth: AuthClient; convex: ConvexReactClient; api: UsernamePasskeyApi }`. Flows call `convex.mutation` for `startSignIn` and `startAutofillSignIn`, `auth.signIn.mutation` for `finishSignIn` and `finishSignUp`, and `auth.setSession`.
- `useUsernamePasskeySignIn`: `const auth = useAuthClient(); const convex = useConvex();`. Remove the four-hook `ctxRef`. Generated function references are a new object on each property access, so keep one `apiRef` for `usernamePasskeyApi` only, or read it through the existing `optionsRef` in `react_impl.tsx` if that already covers every call site. `signIn`'s `useCallback` depends on `[run, auth, convex]`.

`components/email/react.tsx`

- `useSecretStorage()` returns `useAuthClient().signInStorage("email")`. Storage keys become `signUpSecret`. The app's storage is used, which fixes React Native apps that pass secure storage and today get in-memory storage for email. Note the key change in the commit message. Links sent before the upgrade stop completing, which is acceptable before release.
- `useWithSignInPending()` returns `useAuthClient().withSignInPending`.
- `useSignInWithEmailPassword` and `useCompleteSignUp` use `auth.signIn.mutation` and `auth.setSession`.
- `useSignUpWithEmailPassword` runs `signUp` through `useConvex().mutation` (rule 1, the result has no envelope and the proxy returns 500 today). One comment states the rule.
- `useLinkFlow`: do not wait for `isLoading`. On mount, enter `withSignInPending` synchronously and run the storage read and `complete` inside it, so the pending count is up before `init()` resolves (rule 3). Keep the `started` ref. Dependencies use `getFunctionName(completeSignUpMutation)` and `emailCode`, not the raw reference, so the effect does not re-run on every render. Remove the `useAuth` import if nothing else uses it.
- Decide whether `complete` should take `withSignInPending` as a parameter once `useLinkFlow` wraps the whole run. Prefer one wrap, in `useLinkFlow`.

`browser/sessionManager.ts` (rule 7)

- Add a `#loaded` promise that `init()` resolves after it assigns the tokens read from storage. `setSession` awaits it when `init()` has started and has not finished loading. A `setSession` before any `init()` call does not wait. Test: call `setSession` while `init()`'s storage read is pending, then assert the session is kept after `init()` resolves.

`components/password/react.tsx`, `components/anonymous/react.tsx`

- `const auth = useAuthClient();` then `auth.signIn.mutation` and `auth.setSession`. Remove `useAuthActions` from provider code.

Tests for commit 3

- `components/email/react.test.tsx`: the secret storage harness reads through `authClient.signInStorage("email")`. New: the auth state never reports `isLoading: false, isAuthenticated: false` before the link completes. New: `signUp` runs on the `ConvexProvider` client, not the sign-in API. New: the link effect runs its storage read once across rerenders that pass a fresh mutation reference object.
- `components/passkey/react.test.tsx`: harness update. `startSignIn` and `startAutofillSignIn` run on the Convex client stub, the finishing mutations on the sign-in API stub (the file already separates `runMutation` for both, keep that assertion).
- `components/password/react.test.tsx`, `components/anonymous/react.test.tsx`: harness update.
- `browser/sessionManager.test.ts`: the rule 7 race test.

## Commit 4. Sign in while a `ConvexReactClient` has `expectAuth: true` (gated)

Background. `expectAuth` pauses the websocket at construction. Only `setAuth` resumes it, after the first token fetch resolves. `clearAuth` does not resume. `ConvexProviderWithAuth` calls `setAuth` only while `useAuth` reports authenticated. So while signed out, a websocket sign-in mutation never sends. Reading `authentication_manager.ts` in the convex package, `setAuth` with a fetcher that returns null pauses, fetches, reports unauthenticated, and then resumes the socket unauthenticated.

Change, in `react/index.tsx` only

- Subscribe to `auth` once per `[auth, client]`. The first time the snapshot reports `isLoading: false, isAuthenticated: false`, call `client.setAuth(auth.fetchAccessToken, () => {})` once. Do nothing when the first settled state is authenticated, because `ConvexProviderWithAuth` calls `setAuth` itself then.
- Gate. Write the test first. Build `new ConvexReactClient(url, { expectAuth: true, webSocketConstructor: FakeWebSocket })` where `FakeWebSocket` records construction. Without the change no socket is constructed while signed out. With the change one is constructed after `init()` resolves. Also assert that with a persisted session `client.setAuth` is called exactly once (spy), by `ConvexProviderWithAuth`. If the resume does not happen in the test, drop this commit and add a `KNOWN_ISSUES.md` entry that says a `ConvexReactClient` built with `expectAuth: true` cannot run websocket sign-in while signed out.

## Verification before each commit

```sh
pnpm install
pnpm build
pnpm lint
pnpm -r --filter=!argon2id-wasm typecheck
pnpm test
```

Also typecheck the examples (`pnpm typecheck` covers them, use the filter above if the Rust package is not built). Run the OAuth example once by hand if a deployment is available (`cd examples/react-github && pnpm dev`), otherwise say so in the commit message body.

## Done

- The seven-point target API above exists and is exported. `useAuthSignInApi`, `useAmbientSignInValue`, `KeyedStore`, `AmbientSignInClient`, `oauth()`, `OAUTH_ACTIONS_KEY`, `OAUTH_FLOW_ERROR_KEY`, `ambientSignInValues`, the `ambientSignIns` prop, and `ConvexAuthNextjsServerProvider` do not exist in the source.
- All tests listed above exist and pass. Lint, typecheck, and build pass.
- Every example compiles against the new API.
- Commits are on `oauth-client-simplify`, pushed with `git push -u origin oauth-client-simplify`. Four commits (or three if commit 4 is dropped), titled roughly: `Build the auth client outside React`, `Replace the ambient sign-in registry with OAuth flow functions`, `Read the auth client from useAuthClient in provider hooks`, `Resume an expectAuth websocket for sign-in`.
- Report in the final message which spike checks passed (pending flag before init resolves under StrictMode, render-time setter under StrictMode and client identity change, composed callback through the SSR proxy stub, plain JavaScript smoke test, type inference of `auth.signIn.mutation`), and anything you left out.

## Decisions already made, do not reopen

- Two clients as peers with a setter, not the Convex client as a constructor argument.
- Sign-in stays on the websocket in single-page apps. The websocket client re-sends an unfinished mutation after a reconnect with the same request id and the server returns the recorded result. HTTP has no request id and `ConvexHttpClient` has no retry.
- The plugin registry is deleted, not retyped.
- `useOauthSignIn` composes the callback hook. The default `redirectTo` is the current page URL.
- Per-provider hooks stay as thin wrappers.
- Two factories (`createAuthClient`, `createNextjsAuthClient`), not one with a mode flag.
- Hook names `useOauthSignIn` and `useOauthCallback` are placeholders. Keep them unless a reviewer asks.
