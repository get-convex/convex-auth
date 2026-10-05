# Report for card 4

Commit title: "Read the auth client from useAuthClient in provider hooks".

`pnpm lint`, `pnpm -r --filter=!argon2id-wasm typecheck`, `tsc -p scripts`, `pnpm build` (from a clean `dist/`), and `pnpm test` (74 files, 961 tests) pass. Prettier reports no issues in the changed files.

## Files

Changed

- `packages/core/src/browser/sessionManager.ts` has a `#loaded` promise. The first `init()` call sets it before its first `await` and resolves it after it assigns the stored tokens and notifies. `setSession` awaits it when it is not null.
- `packages/core/src/components/passkey/flows.ts` has `SignInFlowContext = { auth, convex, api }`. It imports the `AuthClient` type. The `AuthSignInApi`, `SlimTokenBundle`, and `TokenBundle` imports are removed.
- `packages/core/src/components/passkey/react.tsx` reads `useAuthClient()` and `useConvex()`. One `apiRef` stores the latest `usernamePasskeyApi`. `signIn` depends on `[run, auth, convex]`.
- `packages/core/src/components/email/react.tsx` has the new secret keys, `useSecretStorage()` over `auth.signInStorage("email")`, `useWithSignInPending()` over `useAuthClient()`, the `useLinkFlow` `signsIn` option, `signUp` on `convex.mutation`, and `useCompleteSignUp` memoized on the function path.
- `packages/core/src/components/password/react.tsx` and `components/anonymous/react.tsx` read `useAuthClient()`. Their module tsdocs name `useAuthClient`. The anonymous tsdoc names `useConvexAuth`.
- Tests: `browser/sessionManager.test.ts`, `components/email/react.test.tsx`, `components/passkey/react.test.tsx`.

## Tests added

- `browser/sessionManager.test.ts`, describe "AuthClient setSession during init". "a session set while init reads storage is not lost" fails without the `#loaded` wait. "setSession before any init call stores the session".
- `components/email/react.test.tsx`
  - "never reports signed out before the session is stored" (rule 2). It fails when `useLinkFlow` waits for `isLoading` in the sign-up flow.
  - "reads the secret once across renders with a new reference object".
  - "runs signUp on the Convex client and not through the sign-in API". The three other sign-up tests stub `convexClient.mutation` too.
  - "does not report isLoading while the link is validated", for change email with a stored session. It fails when change email passes `signsIn: true`.
  - "runs the mutation after the auth client loads the session", for change email. It fails when `useLinkFlow` never waits. See the first difference below.
- `components/passkey/react.test.tsx` has two dispatchers, `convexMutations` (`startSignIn`, `startAutofillSignIn`) and `signInMutations` (`finishSignIn`, `finishSignUp`). A mutation on the wrong path throws. Six tests fail when `startSignIn` runs through `auth.signIn`.

## Differences from the card

- `useLinkFlow` with `signsIn: false` waits until the auth client loads. The card said not to wait in either case. `ConvexProviderWithAuth` calls `client.setAuth` only when the auth state is loaded and authenticated, and `setAuth` pauses the socket so later mutations are sent after the token. `AuthProvider` calls `init()` in its effect, which runs after the page's mount effect. Without the wait, the change-email mutation is issued before `setAuth`. If the socket is already open (a fast local backend), the mutation goes out without a token and `completeChangeEmail` returns `NOT_LOGGED_IN`. The effect computes `waitsForAuth = !signsIn && isLoading`, and its deps are `[waitsForAuth, storage, flow, complete, signsIn, withSignInPending]`. The sign-up flow (`signsIn: true`) does not wait.
- `init()` resolves `#loaded` in a `finally` block, so a failed storage read does not leave a later `setSession` waiting forever.
- The secret-read test matches keys with `includes`, because `NamespacedStorage` appends the namespace suffix after the key. This test passes without the path memo too. The `started` ref already limits the flow to one run, so a re-run of the effect is not observable from the hook. The memo only removes the extra effect runs.
- `renderWithProviders` in the email tests returns the `authClient` with the render result. A `seedSession()` helper stores a session in the shared storage. `signInMutation` is a real function reference, because `useCompleteSignUp` calls `getFunctionName` on it.
- The anonymous tsdoc sentence that named `useConvexAuthActions` also said "kicks off". It says "starts".

## For the next card

- The change-email wait depends on `ConvexProviderWithAuth` calling `setAuth` in the commit where the auth state finishes loading. With `expectAuth`, the Convex client holds requests from construction until auth is set, so the wait in `useLinkFlow` could go. The test "runs the mutation after the auth client loads the session" checks the snapshot at the time of the call and would need to change with it.
- A `useCompleteSignUp` run for a user who already has a session reports `isLoading`, which makes `ConvexProviderWithAuth` run `clearAuth()` and `setAuth()` twice. The card accepted this.
- `setSession` after `init()` was called waits at least one microtask, even when the load has finished. A caller that reads the snapshot without awaiting `setSession` sees the old state.
- `useCompletePasswordRecovery` waits for `isLoading` before it reads the secret. It mints a session only on a user action, so it does not use `withSignInPending`.
- `useSignInWithEmailPassword` lists the `signInMutation` reference in its callback deps, so `signIn` is a new function on each render. No effect depends on it.
- The email docs page says the browser keeps the secret in local storage. That is the default storage on the web. A React Native app with secure storage uses that storage.
- The examples were not run by hand. No deployment is available in this environment.
