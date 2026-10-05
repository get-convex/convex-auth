# Card 4 of 5. Read the auth client from useAuthClient in provider hooks

One commit in a five-commit series on branch `erquhart/oauth-client-simplify` in `get-convex/convex-auth`. The series moves auth client construction out of React, gives provider hooks one `useAuthClient()` hook, deletes the ambient sign-in plugin registry, and rebuilds OAuth as plain functions plus thin hooks. This card covers only commit 4. Cards 1 to 3 are on the branch. Do not start the last commit (`expectAuth` support).

Branch setup. `git fetch origin erquhart/oauth-client-simplify && git checkout erquhart/oauth-client-simplify && git pull --ff-only origin erquhart/oauth-client-simplify`. Never push to `reboot`. Do not open a PR.

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

- `browser/sessionManager.ts`: `AuthClient` has `signIn`, `setSignInApi`, `signInStorage(id)`, `init(options?)`, `dispose`, `setSession`, `withSignInPending`, `signOut`, `fetchAccessToken`, `getAccessToken`, `subscribe`, `getSnapshot`. `init()` attaches the storage listener, returns early when `#initialized` is set, sets `#initialized`, writes an initial token if given, then `await Promise.all([storage.get(JWT_STORAGE_KEY), storage.get(REFRESH_TOKEN_STORAGE_KEY)])`, then assigns `#accessToken` and `#refreshToken` from those reads, sets `#isLoading = false`, and notifies. `setSession` writes the tokens through `#storeFullTokenResult`, which assigns the fields and sets `#isLoading = false` before its storage writes resolve.
- `browser/storage.ts`: `SignInStorage` has `get(key)`, `set(key, value)`, and `remove(key)`, each returning what the app's `TokenStorage` method returns, a value or a promise. `NamespacedStorage.forSignIn(id)` builds a new `SignInStorage` object on every call, and `AuthClient.signInStorage(id)` forwards to it, so two calls return two objects. `InMemoryStorage` is the synchronous test storage.
- `react/client.tsx`: `useAuthClient()`, `useAuth()` returning `{ isLoading, isAuthenticated, fetchAccessToken }`, `AuthClientContext`, `AuthProvider`. `react/index.tsx`: `useAuthActions()` returns `{ setSession, signOut }` for apps, and its tsdoc names `useAuthClient` for provider code. `useAuthToken()`.
- `components/passkey/flows.ts`: `SignInFlowContext = { convex: ConvexReactClient; api: UsernamePasskeyApi; signInApi: AuthSignInApi; setSession }` and `runSignInOrSignUpFlow(ctx, { username })`, which calls `convex.mutation(api.startSignIn, ...)` and then `signInApi.mutation(api.finishSignUp | api.finishSignIn, ...)` followed by `setSession(result.tokens)`. The file imports `AuthSignInApi` from `../../browser/signInApi.ts` and `SlimTokenBundle` and `TokenBundle` from `../../lib/types.ts` for the context type only.
- `components/passkey/react.tsx` `useUsernamePasskeySignIn(usernamePasskeyApi)`: reads `useAuthActions().setSession`, `useAuthClient().signIn`, `useConvex()`, builds `ctxRef = useRef({ convex, api, signInApi, setSession })` and reassigns `ctxRef.current` every render. `usePasskeyAutofill({ start, onAssertion })` and `usePasskeyCeremonySlot` come from `react_impl.tsx`, which stores its options in an `optionsRef`. `signIn` is a `useCallback` on `[run]` that passes `ctxRef.current` to `runSignInOrSignUpFlow`.
- `components/email/react.tsx`: `SECRET_STORAGE_KEYS: Record<EmailLinkFlow, string>` has three keys, `signUp: "__convexAuthEmailPasswordSignUpSecret"`, `changeEmail: "__convexAuthEmailPasswordChangeEmailSecret"`, and `passwordRecovery: "__convexAuthEmailPasswordRecoverySecret"`. `useSecretStorage()` returns `useMemo(() => new NamespacedStorage(defaultStorage(), convex.url), [convex])` from `useConvex()`. `useWithSignInPending()` reads `AuthClientContext` through `useContext`. `useLinkFlow(flow, complete)` waits for `useAuth().isLoading === false`, then once (a `started` ref) reads the secret, calls `complete(browserSecret)`, removes the secret on success, with effect deps `[isLoading, storage, flow, complete]`. `useSignInWithEmailPassword` uses `useAuthClient().signIn` and `useAuthActions().setSession`. `useSignUpWithEmailPassword` runs `signUp` through `useAuthClient().signIn.mutation` and stores `result.browserSecret`. `useCompleteSignUp(completeSignUpMutation, { emailCode })` builds `complete` with `useCallback` on `[signInApi, completeSignUpMutation, emailCode, setSession, withSignInPending]`, wraps its body in `withSignInPending`, and passes it to `useLinkFlow("signUp", complete)`. `useCompletePasswordRecovery(recoveryApi, { emailCode })` reads `useAuth().isLoading`, `useAuthActions().setSession`, `useAuthClient().signIn`, and `useSecretStorage()`. It waits for `isLoading === false` before it reads the secret, subscribes to `checkPasswordRecovery` with `useQuery`, and runs `completePasswordRecovery` through `signInApi.mutation` and `setSession`. `useCompleteChangeEmail` builds `complete` from `useMutation(completeChangeEmailMutation)` and passes it to `useLinkFlow("changeEmail", complete)`. The change-email flow mints no session, and the user has one when it runs. `useStartPasswordRecovery` and `useStartChangeEmail` use `useMutation` and the secret storage.
- `components/password/react.tsx` and `components/anonymous/react.tsx` use `useAuthActions().setSession` and `useAuthClient().signIn`. Both module tsdocs point provider authors at `useAuthActions`. The anonymous tsdoc also names `useConvexAuthActions`, which does not exist.
- `convex` 1.46.0 `ConvexProviderWithAuth` (`node_modules/convex/src/react/ConvexAuthState.tsx`) resets its state to loading when `useAuth` reports `isLoading`, and its `setAuth` effect lists `isLoading` as a dependency, so each toggle runs `clearAuth()` and `setAuth()` again. A `withSignInPending` call on a page where the user has a session unmounts `Authenticated` content and restarts the client's auth handshake twice.
- Tests: `components/passkey/react.test.tsx` has a `mutations` object with one `vi.fn()` per mutation name, a `runMutation(fn, args)` dispatcher that treats the reference as a string key into that object, and both stubs built from that one dispatcher, `signInApi = { mutation: runMutation }` and `convexClient = { mutation: runMutation }`. `makeWrapper()` builds an `AuthClient` over `InMemoryStorage`, calls `setSignInApi(signInApi)`, and renders `AuthProvider` around `ConvexProvider`. `components/email/react.test.tsx` has `renderWithProviders(useHook)`, which builds an `AuthClient` over a fresh `InMemoryStorage` with `storageNamespace: NAMESPACE`, calls `setSignInApi(signInApi)` from `stubSignInApi()` in `react/testSignInApi.ts`, and renders `StrictMode`, `ConvexProvider` with `convexClient = new ConvexReactClient(NAMESPACE)`, and `AuthProvider`. The hook under test renders beside `useAuth()`, so `result.current.auth` is the auth state. `stubConvexMutation()` is `vi.spyOn(convexClient, "mutation")`. Secrets are seeded and read through `secretStorage = new NamespacedStorage(window.localStorage, NAMESPACE)` with the constants `SIGN_UP_SECRET_KEY`, `CHANGE_EMAIL_SECRET_KEY`, and `RECOVERY_SECRET_KEY`. The `useCompleteSignUp` describe has the tests "presents the link once when the effect runs again" and "reports isLoading while the link is validated". `components/password/react.test.tsx` and `components/anonymous/react.test.tsx` render `AuthProvider` only. `browser/sessionManager.test.ts` has `makeClient(authApi, storage)`, which accepts a `TokenStorage`, `bundle(n)`, and an `AsyncTokenStorage` class whose methods resolve after one microtask.
- `server/signInProxy.ts` returns 500 for any result that is not the shared sign-in envelope. `signUp` returns `{ success, browserSecret }`, so under Next.js it fails today.
- `examples/react-email-password/src/routes/*.tsx` call the email hooks. The landing routes `validateEmail`, `confirmEmailChange`, and `resetPassword` have no auth guard, so their hooks mount in the page's first render. The hook signatures do not change in this card, so the example does not change.

## Target of this commit

Provider code reads the auth client once with `useAuthClient()` and uses `auth.signIn`, `auth.setSession`, `auth.withSignInPending`, and `auth.signInStorage(id)`. The passkey context built from four hooks and the email storage built from the Convex URL go away. Four email defects and one `AuthClient` race are fixed.

## Rules that must hold

1. Only a function that returns the shared sign-in envelope goes through `auth.signIn`. `startSignIn`, `startAutofillSignIn`, and email `signUp` are ordinary Convex calls through `useConvex()`.
2. `withSignInPending` is entered synchronously in a mount effect, before any `await`, so the pending count is above zero before `init()` resolves. It wraps only a flow that mints a session.
3. `setSession` must not lose a session when it runs while `init()` is loading storage. `init()` assigns the tokens from a storage read that may predate a concurrent `setSession`.
4. App-facing hooks do not change. `useAuthActions`, `useAuthToken`, `useConvexAuth`, `Authenticated`, `Unauthenticated`, `AuthLoading` keep their shape.

## Steps

`browser/sessionManager.ts` (rule 3)

- Add `#loaded: Promise<void> | null = null`. The first `init()` call sets it to a new promise before its first `await` and resolves it after it assigns the tokens read from storage and notifies. A repeat `init()` call returns early and leaves it as it is. `setSession` awaits `#loaded` when it is not null, before `#storeFullTokenResult`. A `setSession` before any `init()` call does not wait. One comment on the field states rule 3.

`components/passkey/flows.ts` and `react.tsx`

- `SignInFlowContext = { auth: AuthClient; convex: ConvexReactClient; api: UsernamePasskeyApi }`. Import the `AuthClient` type from `../../browser/sessionManager.ts`. Drop the `AuthSignInApi`, `SlimTokenBundle`, and `TokenBundle` imports if nothing else in the file uses them. The flow calls `convex.mutation` for `startSignIn`, `auth.signIn.mutation` for `finishSignUp` and `finishSignIn`, and `auth.setSession`. Update the tsdoc on the type, one sentence per field.
- `useUsernamePasskeySignIn`: `const auth = useAuthClient(); const convex = useConvex();`. Remove `useAuthActions` and the four-field `ctxRef`. Generated function references are a new object on each property access, so keep one `apiRef` for `usernamePasskeyApi`, reassigned every render the way `ctxRef` is today. `start` calls `convex.mutation(apiRef.current.startAutofillSignIn, {})`. `onAssertion` calls `auth.signIn.mutation(apiRef.current.finishSignIn, { response })` then `auth.setSession`. `signIn` is a `useCallback` on `[run, auth, convex]` that passes `{ auth, convex, api: apiRef.current }`.

`components/email/react.tsx`

- `SECRET_STORAGE_KEYS = { signUp: "signUpSecret", changeEmail: "changeEmailSecret", passwordRecovery: "passwordRecoverySecret" }`. The `"email"` sign-in storage scopes the keys, so the long prefix is dropped from all three. Update the comment above the constant.
- `useSecretStorage()` returns `useMemo(() => auth.signInStorage("email"), [auth])` with `const auth = useAuthClient()`, typed `SignInStorage`. The memo matters because `signInStorage` returns a new object per call and the storage is an effect dependency. Remove the `NamespacedStorage` and `defaultStorage` imports. `useConvex` stays for `signUp`. The app's storage is used, which fixes React Native apps that pass secure storage and get in-memory storage for email today.
- `useWithSignInPending()` returns `useAuthClient().withSignInPending`. Remove the `AuthClientContext` import, and the `useContext` import if unused.
- `useSignInWithEmailPassword`, `useCompleteSignUp`, and `useCompletePasswordRecovery`: `const auth = useAuthClient();` then `auth.signIn.mutation` and `auth.setSession`. Remove `useAuthActions` from this file. `useCompletePasswordRecovery` keeps its `useAuth().isLoading` wait before the secret read, so `useAuth` stays imported.
- `useSignUpWithEmailPassword`: `const convex = useConvex();` and `convex.mutation(signUpMutation, credentials)` (rule 1). One comment states that the result has no envelope.
- `useLinkFlow(flow, complete, { signsIn })`: do not wait for `isLoading`. In the mount effect, guarded by the `started` ref, define `run` as the async function that reads the secret, calls `complete`, removes the secret on success, and sets the state. With `signsIn: true`, call `withSignInPending(run)` synchronously in the effect (rule 2). With `signsIn: false`, call `run()`. Effect deps are `[storage, flow, complete, signsIn, withSignInPending]`. `useCompleteSignUp` passes `signsIn: true` and drops its own wrap, so there is one wrap. `useCompleteChangeEmail` passes `signsIn: false`, because the user has a session and a loading report restarts the client's auth handshake (see the state section). Update the `useLinkFlow` tsdoc.
- In `useCompleteSignUp`, memoize `complete` on `[auth, getFunctionName(completeSignUpMutation), emailCode]` (`getFunctionName` from `convex/server`, the pattern `oauth/react.ts` uses). Read the reference inside `complete` through a ref reassigned every render, so a fresh reference object on each render does not change `complete` and does not re-run the effect.

`components/password/react.tsx`, `components/anonymous/react.tsx`

- `const auth = useAuthClient();` then `auth.signIn.mutation` and `auth.setSession`. Remove `useAuthActions` from these files. Update the module tsdoc sentences that point provider authors at `useAuthActions`, so they name `useAuthClient`. In the anonymous tsdoc, replace `useConvexAuthActions` with `useConvexAuth`.

## Tests

- `browser/sessionManager.test.ts`: a `TokenStorage` whose `getItem` returns a promise that the test resolves. With `makeClient({}, storage)`, call `const initialized = client.init()`, then `const set = client.setSession(bundle(1))`, then resolve the reads with `null`, then `await Promise.all([initialized, set])`. `getSnapshot()` reports `isAuthenticated: true` and `token: "access-1"` (rule 3). Also assert that `await client.setSession(bundle(1))` on a fresh client with no `init()` call resolves and reports the session.
- `components/email/react.test.tsx`: the hooks read secrets from the auth client's storage, so give the harness one `InMemoryStorage` per test that both the `AuthClient` in `renderWithProviders` and a seeding helper use. The seeding helper is `new NamespacedStorage(authStorage, NAMESPACE).forSignIn("email")` with the keys `signUpSecret`, `changeEmailSecret`, and `passwordRecoverySecret`. Drop the `window.localStorage` seeding. The `useSignUpWithEmailPassword` tests stub `convexClient.mutation` with `stubConvexMutation()`. New tests. (a) Rule 2. Record every `useAuth()` value the harness renders during a `useCompleteSignUp` run whose mutation resolves to a session, and assert that none has `isLoading: false, isAuthenticated: false`. This test fails when `useLinkFlow` waits for `isLoading`. (b) `signUp` runs on `convexClient.mutation` and `runSignInMutation` is not called. (c) The link effect reads the secret once across rerenders that pass a fresh mutation reference object with the same path. Count the `authStorage.getItem` calls whose key ends with `signUpSecret`. (d) `useCompleteChangeEmail` keeps the mutation pending and `result.current.auth.isLoading` is `false` while it runs.
- `components/passkey/react.test.tsx`: split the one `runMutation` dispatcher into two, one for the Convex client stub and one for the sign-in API stub, each with its own per-mutation mocks, so the assertion that `startSignIn` and `startAutofillSignIn` run on the Convex client and `finishSignIn` and `finishSignUp` run on the sign-in API is real. Update the `afterEach` reset loop.
- `components/password/react.test.tsx`, `components/anonymous/react.test.tsx`: no harness change is expected. They render `AuthProvider` only, and the hooks read nothing from `useConvex()`.

## Verification, then commit and push

```sh
pnpm install
pnpm lint
pnpm -r --filter=!argon2id-wasm typecheck
pnpm build
pnpm test
```

All must pass. Commit once with the title `Read the auth client from useAuthClient in provider hooks` and a body that lists the email fixes (app storage, no signed-out render before a link completes, `signUp` over the ordinary client, no effect re-runs from fresh references), the passkey context change, the three email secret key renames, the `useLinkFlow` `signsIn` option, and the `setSession` during `init()` fix. Push with `git push -u origin erquhart/oauth-client-simplify`.

## Final message

List the files you changed, the tests you added, anything you did differently from this card and why, and anything the next card has to know. Do not write the next card yourself.

Write the same report to `plans/oauth-client-simplify/report-4.md` and include it in your commit, so the next planner session can read it from the branch.

After the push, spawn the next planner session as a task card with exactly this prompt and the title `Planner: next card`. "Check out the branch `erquhart/oauth-client-simplify` in `get-convex/convex-auth`, read `plans/oauth-client-simplify/PLANNER-PROMPT.md`, and follow it." If your session has no task card tool, end your final message with that sentence so a person can start the planner from it.
