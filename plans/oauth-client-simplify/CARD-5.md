# Card 5 of 5. Resume an expectAuth websocket for sign-in (gated on a test)

One commit in a five-commit series on branch `erquhart/oauth-client-simplify` in `get-convex/convex-auth`. Cards 1 to 4 are on the branch. This card is the last one and may end with no code change if its test shows the approach does not work.

Branch setup. `git fetch origin erquhart/oauth-client-simplify && git checkout erquhart/oauth-client-simplify && git pull --ff-only origin erquhart/oauth-client-simplify`. Never push to `reboot`. Do not open a PR.

Read `AGENTS.md` at the repo root first. Relative imports in `packages/core/src` carry the on-disk extension (`./client.tsx`). Paths below are relative to `packages/core/src`.

## Working style, to keep your context small

- Read only the files named here. Read the Convex client source only at the lines named.
- While iterating, run `pnpm vitest run packages/core/src/react/index.test.tsx`. Run the full `pnpm lint`, `pnpm -r --filter=!argon2id-wasm typecheck`, `pnpm build`, and `pnpm test` once, before committing.
- Do not paste whole files into your reasoning. Do not fetch any URL.

## Writing rules for code comments, tsdoc, test names, and the commit message

- Plain declarative sentences. Short. No em-dashes. No semicolons or colons inside a sentence.
- No metaphors. Say the literal thing. Banned examples include parked, stashed, in flight, kicks off, torn down, latch, gate, plumbed, threaded through, slot, and code that keeps, holds, carries, owns, pins, honors, or proves something. Say stores, uses, sets, checks, passes.
- Describe only the present. Never write still, now, no longer, used to, instead of, or as before in a comment or doc.
- Clauses after a noun keep their "that" or "which". No fragment-then-colon openers.
- A comment is one short sentence by default.
- The commit title is a short imperative phrase.

## Background

`ConvexReactClient` accepts `expectAuth: true`. In the `convex` package, `browser/sync/client.ts` pauses the websocket at the end of the constructor when that option is set (search for `expectAuth`). `browser/sync/authentication_manager.ts` `setConfig` pauses the socket, awaits the token fetcher, and resumes the socket at the end whether or not a token came back. When no token comes back it runs `refetchToken` with `forceRefreshToken: true` first, then reports unauthenticated through `onAuthChange(false)`, then resumes. `clearAuth` sends a message and does not resume. `react/ConvexAuthState.tsx` (`ConvexProviderWithAuth`) calls `client.setAuth(fetchAccessToken, ...)` only while the `useAuth` hook reports authenticated, and calls `client.clearAuth()` in that effect's cleanup.

So with `expectAuth: true` and a signed-out user, nothing ever calls `setAuth`, the socket stays paused, and a sign-in mutation sent over it waits forever. Convex Auth signs in by sending a mutation over that socket.

The expected fix. If the provider calls `client.setAuth(auth.fetchAccessToken, () => {})` once while signed out, the authentication manager fetches null, reports unauthenticated to the noop callback, and resumes the socket. Queued mutations then send. When the user signs in, `ConvexProviderWithAuth` calls `setAuth` again as it does today. When the user signs out, it calls `clearAuth`, which does not pause.

## State of the branch after card 4

- `react/index.tsx` `ConvexAuthProvider({ client, auth, children })` sets the sign-in API during render and renders `<AuthProvider authClient={auth}><ConvexProviderWithAuth client={client} useAuth={useAuth}>`.
- `browser/sessionManager.ts` `AuthClient` has `subscribe`, `getSnapshot` (`{ isLoading, isAuthenticated, token }`), and `fetchAccessToken({ forceRefreshToken })`, which returns the cached token, or when forced runs the refresh under a cross-tab mutex and returns null with no refresh token.
- `react/index.test.tsx` renders `ConvexAuthProvider` with a real `ConvexReactClient` against `https://happy-animal-123.convex.cloud` and an `AuthClient` from `createAuthClient`.

## Steps

Write the test first. Then the change. Keep whichever outcome the test supports.

Test, in `react/index.test.tsx`

- Define `class FakeWebSocket` with a static `instances: FakeWebSocket[]`, a constructor that records `this`, `readyState = 0`, `send`, `close`, and `addEventListener` no-ops. `ConvexReactClient` accepts `webSocketConstructor` in its options (`convex` package, `browser/sync/client.ts`, `ClientOptions`).
- Case A, signed out. `new ConvexReactClient(url, { expectAuth: true, webSocketConstructor: FakeWebSocket })`, an `AuthClient` with empty storage, render the provider. Wait for `auth.getSnapshot().isLoading === false`. Call `void auth.signIn.mutation(makeFunctionReference<"mutation">("auth:x"), {})`. Assert that a `FakeWebSocket` is constructed (the socket resumed). Before the change this assertion fails and the test documents that.
- Case B, signed in. Seed storage with a session, same client options, spy on `client.setAuth`. After init, `setAuth` is called exactly once, by `ConvexProviderWithAuth`, and the provider's own call did not happen.
- Case C, no `expectAuth`. Same as A without the option. The behavior is unchanged and `setAuth` is called once at most.

Change, in `react/index.tsx` only

- Add an effect on `[auth, client]`. Subscribe to `auth`. The first time the snapshot reports `isLoading: false` and `isAuthenticated: false`, call `client.setAuth(auth.fetchAccessToken, () => {})` once and unsubscribe. If the first settled snapshot is authenticated, unsubscribe without calling anything. Clean up the subscription on unmount. One comment states why, in two sentences at most. Under `expectAuth` the Convex client pauses its websocket until `setAuth` runs, and a signed-out user has to send a sign-in mutation over it.

Gate

- If case A passes with the change and cases B and C pass, commit with the title `Resume an expectAuth websocket for sign-in`.
- If case A does not pass with the change, revert the change, keep no test for it, and add an entry to `KNOWN_ISSUES.md` titled "Sign-in does not run over a websocket built with expectAuth" that says a `ConvexReactClient` built with `expectAuth: true` pauses its websocket until a token arrives, so a websocket sign-in while signed out never sends, and that the Next.js proxy path is not affected. Commit with the title `Document the expectAuth limitation for websocket sign-in`.

## Remove the plans folder

Delete `plans/oauth-client-simplify/` in this commit. The cards and reports stay in the branch history. Put your report in the commit body and in your final message, not in a file.

## Verification, then commit and push

```sh
pnpm install
pnpm lint
pnpm -r --filter=!argon2id-wasm typecheck
pnpm build
pnpm test
```

All must pass. Push with `git push -u origin erquhart/oauth-client-simplify`.

## Final message

Say which gate outcome happened and why. List the files you changed and the tests you added. Then report, for the whole branch, which of these checks have a passing test. The pending flag is set before `init()` resolves under StrictMode. The render-time setter is safe under StrictMode and when the `client` prop identity changes. The composed OAuth callback completes through an ssr-mode client's sign-in API. `auth.signIn.mutation(ref, args)` infers argument and return types from the reference. A plain JavaScript smoke test (an `AuthClient` with `setSignInApi` and no React) signs in and reads a token. Name any check that has no test.
