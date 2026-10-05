# Card 3 of 5. Replace the ambient sign-in registry with OAuth flow functions

One commit in a five-commit series on branch `oauth-client-simplify` in `get-convex/convex-auth`. The series moves auth client construction out of React, gives provider hooks one `useAuthClient()` hook, deletes the ambient sign-in plugin registry, and rebuilds OAuth as plain functions plus thin hooks. This card covers only commit 3. Cards 1 and 2 are on the branch. Do not start the later commits (provider component cleanup, `expectAuth` support).

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
- Clauses after a noun keep their "that" or "which". Use short noun phrases ("the pending flow record"). No fragment-then-colon openers.
- A comment is one short sentence by default. Describe a layer once, at one place.
- The commit title is a short imperative phrase.

## State of the branch after card 2 (verify against the head commit, the branch wins where they differ)

- `browser/sessionManager.ts`: `AuthClient` has `setSignInApi`, `signIn`, `signInStorage(id)`, `init(options?)`, `withSignInPending(fn)` (increments a pending counter synchronously before awaiting `fn`, and the snapshot reports `isLoading` while the counter is above zero), `setSession`, `subscribe`, `getSnapshot`. It also has the ambient system. `ambientSignIns?: ReadonlyArray<AmbientSignInClient>` config, `#ambientValues: KeyedStore`, `ambientSignInValues(id)`, `#initCallbacks`, `#registerAmbientSignIns`, and a loop in `init()` that runs `onInit` callbacks before the session load.
- `browser/ambientSignInClient.ts`: types `AuthSignInApi`, `AmbientSignInClient`, `AmbientSignInContext`. `browser/keyedStore.ts`: `KeyedStore`, `SignInValues`, `SignInValuesReader`. `react/providers.ts`: `useAmbientSignInValue(id, key)`. `browser/index.ts` and `react/index.tsx` export the ambient types.
- `browser/createAuthClient.ts`: has an `ambientSignIns` option defaulting to `[oauth()]` and imports `oauth` from `../oauth/client.ts`.
- `oauth/client.ts`: exports `OauthProviderApi`, `OauthProviderRefs`, `OauthFlowErrorCode`, `OauthFlowError`, `SignInOptions`, `SignInOutcome`, `OauthActions`, `OAUTH_SETUP_ID = "oauth"`, `OAUTH_ACTIONS_KEY`, `OAUTH_FLOW_ERROR_KEY`, `PendingFlow`, and `oauth(): AmbientSignInClient`. Inside `oauth()` are `setFlowError`, `setThrownFlowError`, `completeFlow(code)` (wrapped in `client.withSignInPending`, reads the pending flow with `takePendingFlow`, rebuilds the `completeSignIn` reference from the stored path with `makeFunctionReference`, calls `signInApi.mutation` through `retryOnNetworkError`, then `client.setSession`), `handleCallback()` (reads `OAUTH_CODE_PARAM` and `OAUTH_ERROR_PARAM` from `lib/oauthParams.ts`, removes them before the first await, passes `window.history.state` back through `replaceState`), and `signIn(refs, options)` (starts a flow through `signInApi.mutation(refs.startSignIn, { redirectTo })`, stores the pending flow under `OAUTH_FLOW_STORAGE_KEY = "flow"`, navigates unless `navigator.product === "ReactNative"`, or completes with `options.code`). Module level helpers `currentHref`, `takePendingFlow`, `dropPendingFlow`, `SERVER_ERRORS`.
- `oauth/react.ts`: `useOauth()`, `useOauthSignIn(refs)`, `useSignInWithGoogle/Apple/Github(api)`, all reading the keyed store through `useAmbientSignInValue`, plus `NOT_REGISTERED_ERROR` and a re-export of `oauth`.
- `oauth/testFlow.ts`: `oauthClient(storage)`, `setupOAuth()`, `seedPendingFlow`, `readFlow`, `flowStorage`, `acmeRefs`, `bundle`, `completed`, `invalidCode`, `calledPath`, `stubReactNative`, `restoreNavigatorProduct`. Tests: `oauth/client.test.ts`, `oauth/clientEnvironment.test.ts` (node environment, no `window` cases), `oauth/react.test.tsx`, `react/index.test.tsx` (ambient tests), `react/providers.test.tsx`, `browser/keyedStore.test.ts`, `browser/sessionManager.test.ts` (describe "AuthClient ambient sign-ins").
- `server/signInProxy.ts` `classifyResult` returns 500 for any result that is not `{ status: "complete", tokens }` or `{ status: "error", userError }`.
- `KNOWN_ISSUES.md` has an entry "OAuth isn't wired into the Next.js client".
- Examples `examples/react-github|google|apple/src/App.tsx` use `useOauth()` and a per-provider hook. Their `main.tsx` uses `createAuthClient` with no `ambientSignIns` option.

## Target of this commit

```ts
// oauth/client.ts
type OauthClientContext = { auth: AuthClient; convex: Pick<AuthSignInApi, "mutation"> };
startOauthSignIn(ctx, refs, options?): Promise<SignInOutcome>;
completeOauthSignIn(ctx, code): Promise<boolean>;
readOauthCallback(): { code: string } | { error: OauthFlowErrorCode } | null;   // synchronous
handleOauthCallback(ctx): boolean;                                               // synchronous entry for a mount effect

// oauth/react.ts
useOauthSignIn(refs): { signIn }   // starts on click, completes a callback on mount
useOauthCallback(): { flowError }  // for a custom redirectTo landing page
useOauth(): { flowError }          // read the flow error from any component
useSignInWithGoogle(api), useSignInWithApple(api), useSignInWithGithub(api)   // unchanged shape
```

The plugin registry, the keyed store, and the generic read hook are deleted.

## Rules that must hold

1. Only a function that returns the shared sign-in envelope goes through `auth.signIn`. `startSignIn` returns `{ redirect, state }`, so it runs through `ctx.convex.mutation`. `completeSignIn` returns the envelope, so it runs through `ctx.auth.signIn.mutation`.
2. Callback params are read and removed from the URL synchronously, before the first `await`, and `window.history.state` is passed back through `replaceState`. A second run sees a clean URL and does nothing. Params the app uses for its own purposes (`?code=`, `?error=`) are left alone.
3. `withSignInPending` is entered synchronously from the mount effect. React runs child effects before parent effects, so a hook rendered inside the provider enters it before `AuthProvider`'s `init()` effect. The app never observes `isLoading: false, isAuthenticated: false` while a completion is in progress.
4. `OAUTH_STORAGE_ID` stays the string `"oauth"` so a flow saved before this commit is found.
5. `retryOnNetworkError` is not applied in `oauth/client.ts`. The Next.js factory applies it to the proxy sign-in API, and the SPA websocket client re-sends an unfinished mutation itself.

## Steps

Delete

- `browser/ambientSignInClient.ts`, `browser/keyedStore.ts`, `browser/keyedStore.test.ts`, `react/providers.ts`, `react/providers.test.tsx`.
- Move the `AuthSignInApi` type to a new `browser/signInApi.ts`, keep its tsdoc minus the sentence about callers retrying, and update every import (`sessionManager.ts`, `createAuthClient.ts`, `react/client.tsx`, `react/index.tsx`, `nextjs/index.tsx`, `components/passkey/flows.ts`, `oauth/testFlow.ts`, `react/testSignInApi.ts`, and any other grep hit).
- In `sessionManager.ts`: remove the `ambientSignIns` config, `#ambientValues`, `ambientSignInValues()`, `#initCallbacks`, `#registerAmbientSignIns`, the `onInit` loop in `init()`, and the `KeyedStore` import. Keep the id regex check inside `signInStorage`.
- In `createAuthClient.ts`: remove the `ambientSignIns` option and the `oauth` import. In `browser/index.ts` and `react/index.tsx`: remove the ambient type exports.

`oauth/flowState.ts` (new)

- A per-client flow error store, so `useOauth()` works from a component other than the one that ran the callback. `const states = new WeakMap<AuthClient, { error: OauthFlowError | null; listeners: Set<() => void> }>()`, with `getOauthFlowError(auth)`, `setOauthFlowError(auth, error)` (notifies listeners), and `subscribeOauthFlowError(auth, listener)` (returns an unsubscribe function). No string keys.

`oauth/client.ts`

- Keep the types `OauthProviderApi`, `OauthProviderRefs`, `OauthFlowErrorCode`, `OauthFlowError`, `SignInOptions`, `SignInOutcome`, `PendingFlow`, and the helpers `SERVER_ERRORS`, `OAUTH_FLOW_STORAGE_KEY`, `currentHref`, `takePendingFlow`, `dropPendingFlow`.
- Remove `oauth()`, `OauthActions`, `OAUTH_ACTIONS_KEY`, `OAUTH_FLOW_ERROR_KEY`, the `AmbientSignInClient` import, and the `retryOnNetworkError` import. Rename `OAUTH_SETUP_ID` to `OAUTH_STORAGE_ID` with the same value.
- Add `export type OauthClientContext = { auth: AuthClient; convex: Pick<AuthSignInApi, "mutation"> }` with a tsdoc that states rule 1.
- `export async function startOauthSignIn(ctx, refs, options?)`. The body of today's `signIn`. `options.code` delegates to `completeOauthSignIn` (the React Native path). `startSignIn` runs through `ctx.convex.mutation`. The pending flow is stored in `ctx.auth.signInStorage(OAUTH_STORAGE_ID)`. Flow errors go through `setOauthFlowError(ctx.auth, ...)`. Keep the `setThrownFlowError` logic (a `ConvexError` with a string `data` becomes `rejected` with that message, anything else becomes `oauth_error`).
- `export async function completeOauthSignIn(ctx, code)`. The body of today's `completeFlow`. Runs inside `ctx.auth.withSignInPending`, reads the pending flow from `ctx.auth.signInStorage(OAUTH_STORAGE_ID)`, redeems through `ctx.auth.signIn.mutation(completeSignIn, { code, state })`, calls `ctx.auth.setSession(result.tokens)`, never rejects.
- `export function readOauthCallback()`. The URL part of today's `handleCallback` (rule 2). Returns `null` when there is no page URL or neither param is present.
- `export function handleOauthCallback(ctx)`. Calls `readOauthCallback()`. On an error param, `void dropPendingFlow(storage)` and set the flow error (`SERVER_ERRORS` membership decides between the server's code and `oauth_error`). On a code, `void completeOauthSignIn(ctx, code)`. Returns whether a param was present.
- Rewrite the module tsdoc. State rules 1 and 2 there, once.

`oauth/react.ts`

- `useOauth()`: `const auth = useAuthClient()` and `useSyncExternalStore((l) => subscribeOauthFlowError(auth, l), () => getOauthFlowError(auth), () => null)`.
- `useOauthCallback()`: `const auth = useAuthClient(); const convex = useConvex();` (from `convex/react`), `useEffect(() => { handleOauthCallback({ auth, convex }); }, [auth, convex])`, and returns `useOauth()`.
- `useOauthSignIn(refs)`: calls `useOauthCallback()`. `signIn` is memoized on `[auth, convex, providerName, startPath, completePath]` using the existing `getFunctionName` pattern, and calls `startOauthSignIn({ auth, convex }, refs, options)`. Returns `{ signIn }`.
- Per-provider hooks keep their shape. Remove `NOT_REGISTERED_ERROR` and the `oauth` re-export. Rewrite the module tsdoc. Say that `useOauthSignIn` completes a callback on mount, that `useOauthCallback` is for a custom `redirectTo` page, and that under `ConvexAuthNextjsProvider` the provider's `completeSignIn*` function has to be in the proxy `signIn` allowlist while `startSignIn*` runs over the ordinary Convex client.

`KNOWN_ISSUES.md`

- Remove "OAuth isn't wired into the Next.js client". Check that the other OAuth entries name files that exist.

Examples

- `examples/react-github|google|apple/src/App.tsx` keep working with no change. Check their imports compile.

## Tests

- `oauth/testFlow.ts`: replace `oauthClient` and `setupOAuth` with a helper that returns `{ auth, convex, completeMutation, startMutation, flowError, storage }` where `auth = new AuthClient({ mode: "spa", ... })` with `auth.setSignInApi({ mutation: completeMutation, action: vi.fn() })`, `convex = { mutation: startMutation }`, and `flowError = () => getOauthFlowError(auth)`. Keep the other helpers.
- `oauth/client.test.ts`: rewrite against `handleOauthCallback`, `completeOauthSignIn`, `startOauthSignIn`. Same scenarios as today. A callback code is redeemed and the session adopted. Removing the params keeps the history state. The state never reports signed out while a code is redeemed (call `handleOauthCallback` then `auth.init()`, subscribe, and assert no snapshot has `isLoading: false, isAuthenticated: false`). A second client on the same URL finds it clean and does nothing. A callback error param sets the flow error, removes the URL params, and consumes the pending flow. An unknown error param normalizes to `oauth_error`. A code without a pending flow sets `invalid_flow`. A pending flow without a `completeSignIn` path is invalid. `INVALID_CODE` sets `expired`. A thrown redemption sets `oauth_error`. A `ConvexError` sets `rejected` with and without a message. A rejected storage read during redemption sets `oauth_error`. A rejected storage removal during error cleanup keeps the flow error. `startOauthSignIn` starts a flow through `startMutation`, persists it, and returns the redirect. `startOauthSignIn` with `code` completes the pending flow through `completeMutation`. It clears a previous flow error. A failed, unsavable, or rejected start sets the flow error and rejects. Foreign `?code=` and `?error=` params are ignored and left in the URL.
- `oauth/clientEnvironment.test.ts`: `readOauthCallback()` returns null and `handleOauthCallback` calls neither mutation with no `window` and with `window` that has no `location`.
- `oauth/react.test.tsx`: the hooks throw outside a provider. A StrictMode double mount redeems a callback code once. A callback error param reaches `useOauth()` in a sibling component. `useOauthSignIn`'s `signIn` starts a flow through the `ConvexProvider` client's `mutation`, not through `auth.signIn`. `signInGithub` starts a flow with the GitHub references. `useOauthSignIn` runs a provider that ships no hook of its own. `signInGoogle` keeps a stable identity across rerenders. The hook params accept the api module structurally. New, rule 3: with `?convexAuthCode=` in the URL under StrictMode, no snapshot reports `isLoading: false, isAuthenticated: false` before `setSession`. New: an ssr-mode `AuthClient` whose sign-in API is a stub completes through that stub while `startSignIn` goes through the `ConvexProvider` client.
- `browser/sessionManager.test.ts`: delete the ambient describe. Add a test that `withSignInPending` entered before `init()` resolves keeps `isLoading` true past the session load.
- `react/index.test.tsx`: remove the ambient tests and any `ambientSignIns` option use.
- Harness for the React tests: `<AuthProvider authClient={auth}>` inside `<ConvexProvider client={...}>` with a client stub `{ mutation: startMutation, setAuth: vi.fn(), clearAuth: vi.fn() }` or a real `ConvexReactClient` against a fake URL, whichever the existing OAuth React tests use.

## Verification, then commit and push

```sh
pnpm install
pnpm lint
pnpm -r --filter=!argon2id-wasm typecheck
pnpm build
pnpm test
```

All must pass. Commit once with the title `Replace the ambient sign-in registry with OAuth flow functions` and a body that lists the deleted modules and the new functions. Push with `git push -u origin oauth-client-simplify`.

## Final message

List the files you changed and deleted, the tests you added, anything you did differently from this card and why, and anything the next card has to know. Do not write the next card yourself.

Write the same report to `plans/oauth-client-simplify/report-3.md` and include it in your commit, so the next planner session can read it from the branch.
