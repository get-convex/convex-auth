# Card 4 of 5. Read the auth client from useAuthClient in provider hooks

One commit in a five-commit series on branch `oauth-client-simplify` in `get-convex/convex-auth`. The series moves auth client construction out of React, gives provider hooks one `useAuthClient()` hook, deletes the ambient sign-in plugin registry, and rebuilds OAuth as plain functions plus thin hooks. This card covers only commit 4. Cards 1 to 3 are on the branch. Do not start the last commit (`expectAuth` support).

Branch setup. `git fetch origin oauth-client-simplify && git checkout oauth-client-simplify && git pull --ff-only origin oauth-client-simplify`. Never push to `reboot`. Do not open a PR.

Read `AGENTS.md` at the repo root first. Relative imports in `packages/core/src` carry the on-disk extension (`./client.tsx`). Paths below are relative to `packages/core/src`.

## Working style, to keep your context small

- Read only the files named here, and use grep for call sites. Read the harness part of a test file and the tests you change, not the whole file.
- While iterating, run single test files with `pnpm vitest run packages/core/src/<file>`. Run the full `pnpm lint`, `pnpm -r --filter=!argon2id-wasm typecheck`, `pnpm build`, and `pnpm test` once, before committing.
- Do not paste whole files into your reasoning. Do not fetch any URL.

## Writing rules for code comments, tsdoc, test names, and the commit message

- Plain declarative sentences. Short. No em-dashes. No semicolons or colons inside a sentence.
- No metaphors. Say the literal thing. Banned examples include parked, stashed, in flight, kicks off, torn down, latch, gate, plumbed, threaded through, slot, and code that keeps, holds, carries, owns, pins, honors, or proves something. Say stores, uses, sets, checks, passes.
- Describe only the present. Never write still, now, no longer, used to, instead of, or as before in a comment or doc.
- Clauses after a noun keep their "that" or "which". Use short noun phrases ("the secret storage"). No fragment-then-colon openers.
- A comment is one short sentence by default. Describe a layer once, at one place.
- The commit title is a short imperative phrase.

## State of the branch after card 3 (verify against the head commit, the branch wins where they differ)

- `browser/sessionManager.ts`: `AuthClient` has `signIn`, `setSignInApi`, `signInStorage(id)`, `init(options?)`, `setSession`, `withSignInPending`, `signOut`, `fetchAccessToken`, `subscribe`, `getSnapshot`. `init()` sets `#initialized`, writes an initial token if given, then `await Promise.all([storage.get(JWT_STORAGE_KEY), storage.get(REFRESH_TOKEN_STORAGE_KEY)])`, then assigns `#accessToken` and `#refreshToken` from those reads, sets `#isLoading = false`, and notifies. `setSession` writes the tokens through `#storeFullTokenResult`.
- `react/client.tsx`: `useAuthClient()`, `useAuth()`, `AuthClientContext`, `AuthProvider`. `react/index.tsx`: `useAuthActions()` returns `{ setSession, signOut }` for apps, `useAuthToken()`.
- `components/passkey/flows.ts`: `SignInFlowContext = { convex: ConvexReactClient; api: UsernamePasskeyApi; signInApi: AuthSignInApi; setSession }` and `runSignInOrSignUpFlow(ctx, { username })`, which calls `convex.mutation(api.startSignIn, ...)` and then `signInApi.mutation(api.finishSignUp | api.finishSignIn, ...)` followed by `setSession(result.tokens)`.
- `components/passkey/react.tsx` `useUsernamePasskeySignIn(usernamePasskeyApi)`: reads `useAuthActions().setSession`, `useAuthClient().signIn`, `useConvex()`, builds `ctxRef = useRef({ convex, api, signInApi, setSession })` and reassigns `ctxRef.current` every render. `usePasskeyAutofill({ start, onAssertion })` and `usePasskeyCeremonySlot` come from `react_impl.tsx`, which stores its options in an `optionsRef`. `signIn` is a `useCallback` on `[run]` that passes `ctxRef.current` to `runSignInOrSignUpFlow`.
- `components/email/react.tsx`: `SECRET_STORAGE_KEYS = { signUp: "__convexAuthEmailPasswordSignUpSecret" }`. `useSecretStorage()` returns `useMemo(() => new NamespacedStorage(defaultStorage(), convex.url), [convex])` from `useConvex()`. `useWithSignInPending()` reads `AuthClientContext`. `useLinkFlow(flow, complete)` waits for `useAuth().isLoading === false`, then once (a `started` ref) reads the secret, calls `complete(browserSecret)`, removes the secret on success, with effect deps `[isLoading, storage, flow, complete]`. `useSignInWithEmailPassword` uses `useAuthClient().signIn` and `useAuthActions().setSession`. `useSignUpWithEmailPassword` runs `signUp` through `useAuthClient().signIn.mutation` and stores `result.browserSecret`. `useCompleteSignUp(completeSignUpMutation, { emailCode })` builds `complete` with `useCallback` on `[signInApi, completeSignUpMutation, emailCode, setSession, withSignInPending]` and passes it to `useLinkFlow("signUp", complete)`.
- `components/password/react.tsx` and `components/anonymous/react.tsx` use `useAuthActions().setSession` and `useAuthClient().signIn`.
- Tests: `components/passkey/react.test.tsx` (a `runMutation` mock shared by the Convex client stub and the sign-in API stub, rendered inside `AuthProvider` and `ConvexProvider`), `components/email/react.test.tsx` (seeds secrets through `new NamespacedStorage(window.localStorage, NAMESPACE)` with the long key), `components/password/react.test.tsx`, `components/anonymous/react.test.tsx`, `browser/sessionManager.test.ts`.
- `server/signInProxy.ts` returns 500 for any result that is not the shared sign-in envelope. `signUp` returns `{ success, browserSecret }`, so under Next.js it fails today.

## Target of this commit

Provider code reads the auth client once with `useAuthClient()` and uses `auth.signIn`, `auth.setSession`, `auth.withSignInPending`, and `auth.signInStorage(id)`. The passkey context built from four hooks and the email storage built from the Convex URL go away. Four email defects and one `AuthClient` race are fixed.

## Rules that must hold

1. Only a function that returns the shared sign-in envelope goes through `auth.signIn`. `startSignIn`, `startAutofillSignIn`, and email `signUp` are ordinary Convex calls through `useConvex()`.
2. `withSignInPending` is entered synchronously in a mount effect, before any `await`, so the pending count is above zero before `init()` resolves.
3. `setSession` must not lose a session when it runs while `init()` is loading storage. `init()` assigns the tokens from a storage read that may predate a concurrent `setSession`.
4. App-facing hooks do not change. `useAuthActions`, `useAuthToken`, `useConvexAuth`, `Authenticated`, `Unauthenticated`, `AuthLoading` keep their shape.

## Steps

`browser/sessionManager.ts` (rule 3)

- Add a `#loaded: Promise<void>` with its resolver. `init()` resolves it after assigning the tokens read from storage (also on the early return path when `init()` already ran). `setSession` awaits `#loaded` when `init()` has started and has not finished loading. A `setSession` before any `init()` call does not wait.

`components/passkey/flows.ts` and `react.tsx`

- `SignInFlowContext = { auth: AuthClient; convex: ConvexReactClient; api: UsernamePasskeyApi }`. The flow calls `convex.mutation` for `startSignIn`, `auth.signIn.mutation` for `finishSignUp` and `finishSignIn`, and `auth.setSession`. Update the tsdoc on the type, one sentence per field.
- `useUsernamePasskeySignIn`: `const auth = useAuthClient(); const convex = useConvex();`. Remove `useAuthActions` and the four-field `ctxRef`. Generated function references are a new object on each property access, so keep one `apiRef` for `usernamePasskeyApi` if `signIn` or the autofill callbacks need the latest value. `start` calls `convex.mutation(apiRef.current.startAutofillSignIn, {})`. `onAssertion` calls `auth.signIn.mutation(apiRef.current.finishSignIn, { response })` then `auth.setSession`. `signIn` is a `useCallback` on `[run, auth, convex]` that passes `{ auth, convex, api: apiRef.current }`.

`components/email/react.tsx`

- `SECRET_STORAGE_KEYS = { signUp: "signUpSecret" }`. `useSecretStorage()` returns `useAuthClient().signInStorage("email")`. Remove the `NamespacedStorage`, `defaultStorage`, and `useConvex` imports if unused after the other changes (`useConvex` stays for `signUp`). The app's storage is used, which fixes React Native apps that pass secure storage and get in-memory storage for email today.
- `useWithSignInPending()` returns `useAuthClient().withSignInPending`. Remove the `AuthClientContext` import.
- `useSignInWithEmailPassword` and `useCompleteSignUp`: `const auth = useAuthClient();` then `auth.signIn.mutation` and `auth.setSession`. Remove `useAuthActions` from this file.
- `useSignUpWithEmailPassword`: `const convex = useConvex();` and `convex.mutation(signUpMutation, credentials)` (rule 1). One comment states that the result has no envelope.
- `useLinkFlow`: do not wait for `isLoading`. In the mount effect, guarded by the `started` ref, call `withSignInPending(async () => { read the secret, call complete, remove the secret on success })` synchronously (rule 2). Move the `withSignInPending` wrap out of `useCompleteSignUp`'s `complete` so there is one wrap. Effect deps are `[storage, flow, complete]`. In `useCompleteSignUp`, memoize `complete` on `[auth, getFunctionName(completeSignUpMutation), emailCode]` and read the reference through a ref or by rebuilding it from the path, so a fresh reference object on each render does not re-run the effect. Remove the `useAuth` import if nothing else uses it. Update the `useLinkFlow` tsdoc.

`components/password/react.tsx`, `components/anonymous/react.tsx`

- `const auth = useAuthClient();` then `auth.signIn.mutation` and `auth.setSession`. Remove `useAuthActions` from these files. Update the module tsdoc sentences that point provider authors at `useAuthActions`.

`react/index.tsx`

- The `useAuthActions` tsdoc says apps use it for `signOut` and provider code uses `useAuthClient()`.

## Tests

- `browser/sessionManager.test.ts`: a storage whose `getItem` resolves on a controlled promise. Call `init()`, then `setSession(bundle)`, then release the read with `null` values. After `init()` resolves, `getSnapshot()` reports the session (rule 3). Also assert `setSession` before any `init()` resolves without waiting.
- `components/email/react.test.tsx`: seed and read secrets through `authClient.signInStorage("email")` with the key `signUpSecret`. New: subscribe to the auth client and assert no snapshot has `isLoading: false, isAuthenticated: false` before the link completes. New: `signUp` runs on the `ConvexProvider` client's `mutation`, not the sign-in API. New: the link effect reads the secret once across rerenders that pass a fresh mutation reference object (spy on `storage.get`).
- `components/passkey/react.test.tsx`: update the harness. `startSignIn` and `startAutofillSignIn` run on the Convex client stub, `finishSignIn` and `finishSignUp` on the sign-in API stub. If the file shares one `runMutation` mock between both stubs, split it so the assertion is real.
- `components/password/react.test.tsx`, `components/anonymous/react.test.tsx`: harness update only if the hooks' imports changed what the tests render.

## Verification, then commit and push

```sh
pnpm install
pnpm lint
pnpm -r --filter=!argon2id-wasm typecheck
pnpm build
pnpm test
```

All must pass. Commit once with the title `Read the auth client from useAuthClient in provider hooks` and a body that lists the email fixes (app storage, no signed-out render before a link completes, `signUp` over the ordinary client, no effect re-runs from fresh references), the passkey context change, the email secret key change, and the `setSession` during `init()` fix. Push with `git push -u origin oauth-client-simplify`.

## Final message

List the files you changed, the tests you added, anything you did differently from this card and why, and anything the next card has to know. Do not write the next card yourself.

Write the same report to `plans/oauth-client-simplify/report-4.md` and include it in your commit, so the next planner session can read it from the branch.
