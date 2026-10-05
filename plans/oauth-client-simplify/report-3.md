# Report for card 3

Commit title: "Replace the ambient sign-in registry with OAuth flow functions".

`pnpm lint`, `pnpm -r --filter=!argon2id-wasm typecheck`, `tsc -p scripts`, `pnpm build` (from a clean `dist/`), and `pnpm test` (74 files, 954 tests) pass.

## Files

Deleted

- `packages/core/src/browser/ambientSignInClient.ts`
- `packages/core/src/browser/keyedStore.ts`
- `packages/core/src/browser/keyedStore.test.ts`
- `packages/core/src/react/providers.ts`
- `packages/core/src/react/providers.test.tsx`

Added

- `packages/core/src/browser/signInApi.ts` exports `AuthSignInApi`.
- `packages/core/src/oauth/flowState.ts` exports `getOauthFlowError`, `setOauthFlowError`, and `subscribeOauthFlowError`, backed by a `WeakMap<AuthClient, ...>`.

Changed

- `packages/core/src/browser/sessionManager.ts` has no ambient config, values, init callbacks, or `onInit` loop. `checkSignInId` is used only by `signInStorage`. The `withSignInPending` tsdoc says that a call made before `init()` resolves reports loading until it settles.
- `packages/core/src/browser/createAuthClient.ts` has no `ambientSignIns` option and no `oauth` import.
- `packages/core/src/browser/index.ts` exports `AuthSignInApi` from `./signInApi.ts` and no ambient types.
- `packages/core/src/react/index.tsx` has no `AmbientSignInClient` export. `react/client.tsx` imports `AuthSignInApi` from `browser/signInApi.ts` and re-exports it.
- `packages/core/src/components/passkey/flows.ts` and `browser/createAuthClient.test.ts` import `AuthSignInApi` from `browser/signInApi.ts`.
- `packages/core/src/browser/storage.ts` has two doc comments reworded. They named ambient sign-ins.
- `packages/core/package.json` has no `./react/providers` export.
- `packages/core/src/oauth/client.ts` exports `OauthClientContext`, `OAUTH_STORAGE_ID = "oauth"`, `startOauthSignIn`, `completeOauthSignIn`, `readOauthCallback`, and `handleOauthCallback`. It has no `oauth()`, `OauthActions`, `OAUTH_SETUP_ID`, `OAUTH_ACTIONS_KEY`, `OAUTH_FLOW_ERROR_KEY`, or `retryOnNetworkError`.
- `packages/core/src/oauth/react.ts` has `useOauth`, `useOauthCallback`, `useOauthSignIn`, and the three per-provider hooks. It has no `NOT_REGISTERED_ERROR`, no `oauth` re-export, and no `OauthActions` type re-export.
- `packages/core/src/nextjs/index.tsx` wraps the proxy sign-in API's `mutation` and `action` in `retryOnNetworkError`. `browser/retry.ts` has a new module tsdoc and no code change.
- `KNOWN_ISSUES.md` has no "OAuth isn't wired into the Next.js client" entry. Two entries name `auth.signInStorage("oauth")`, `handleOauthCallback`, and `startOauthSignIn`. Every path in the file exists.
- `examples/react-github|google|apple/src/App.tsx` call `useOauthCallback()` in `App`.
- Tests: `oauth/testFlow.ts`, `oauth/client.test.ts`, `oauth/clientEnvironment.test.ts`, `oauth/react.test.tsx`, `browser/sessionManager.test.ts`, `react/index.test.tsx`, `nextjs/index.test.tsx`.

## Tests added

- `oauth/client.test.ts`: "readOauthCallback returns the code once and removes it". The other tests cover the scenarios the card lists, against `handleOauthCallback`, `completeOauthSignIn`, and `startOauthSignIn`.
- `oauth/react.test.tsx`: "the auth state never reports signed out while a callback code is redeemed" (rule 3, StrictMode, checks both store snapshots and rendered values). "an ssr-mode client completes through its sign-in API and starts through the ConvexProvider client". "a callback error param reaches useOauth in a sibling component" renders two components.
- `browser/sessionManager.test.ts`: "withSignInPending entered before init reports loading past the session load".
- `nextjs/index.test.tsx`: "a sign-in call retries after a network error", with fake timers.

I checked that the rule 3 React test fails when `useOauthCallback` defers `handleOauthCallback` with a timer, and that the retry test fails without the wrap.

## Differences from the card

- The examples change. Each OAuth example's `App` renders `SignedOut`, which calls the sign-in hook, only when `!isLoading && !isAuthenticated`. On the callback page the hook does not mount in the first render, so the auth state reports signed out for one render before the redemption starts, and the sign-in screen shows briefly. `App` calls `useOauthCallback()`, so the callback completes in the first render's effects. The `oauth/react.ts` module tsdoc states this requirement.
- `package.json` loses the `./react/providers` export. Its target module is deleted.
- `readOauthCallback()` maps an unknown server error code to `oauth_error`. Its return type `{ error: OauthFlowErrorCode }` needs a normalized code. `handleOauthCallback` uses the value as given.
- `useOauth` memoizes the `subscribe` function with `useCallback` on `[auth]`, so React does not resubscribe on every render.
- The test helper is `oauthContext({ storage })`. Some redemption failure tests call `completeOauthSignIn` directly in place of a callback URL.
- `sessionManager.test.ts` keeps the `SIGN_IN_API` and `SIGN_IN_REF` constants, moved above the "AuthClient sign-in API" describe, because those tests use them.
- The `AuthSignInApi` tsdoc list items are reworded to avoid colons.

## For the next card

- `AuthSignInApi` is in `browser/signInApi.ts`. `components/passkey/flows.ts` imports it from there.
- A hook that completes a sign-in on mount upholds "never signed out during a completion" only when it mounts in the page's first render. Card 4's email link flow (`useLinkFlow` through `useCompleteSignUp`) has the same condition. Check where `examples/react-email-password` renders the component that calls `useCompleteSignUp`.
- `init()` and an early `setSession` can race. `init()` reads both tokens from storage and assigns them after `await`, so a `setSession` that finishes between the read and the assignment is overwritten. With `InMemoryStorage` the reads resolve first. Card 4 already lists this fix.
- The OAuth examples were not run by hand. No deployment is available in this environment.
