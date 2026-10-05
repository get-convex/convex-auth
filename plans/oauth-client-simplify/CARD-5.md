# Card 5 of 5. Resume an expectAuth websocket for sign-in (gated on a test)

One commit in a five-commit series on branch `erquhart/oauth-client-simplify` in `get-convex/convex-auth`. Cards 1 to 4 are on the branch. This card is the last one and may end with no code change if its test shows the approach does not work.

Branch setup. `git fetch origin erquhart/oauth-client-simplify && git checkout erquhart/oauth-client-simplify && git pull --ff-only origin erquhart/oauth-client-simplify`. Never push to `reboot`. Do not open a PR.

Read `AGENTS.md` at the repo root first. Relative imports in `packages/core/src` carry the on-disk extension (`./client.tsx`). Paths below are relative to `packages/core/src` unless they start with `convex/`.

## Working style, to keep your context small

- Read only the files named here. Read the `convex` package source only at the lines named.
- Run `pnpm install` once. The `convex` source is at `packages/core/node_modules/convex/src/`. The installed version is 1.46.0 and the line numbers below are for that version.
- While iterating, run `pnpm vitest run packages/core/src/react/index.test.tsx` from the repo root. Run the full `pnpm lint`, `pnpm -r --filter=!argon2id-wasm typecheck`, `pnpm build`, and `pnpm test` once, before committing.
- Do not paste whole files into your reasoning. Do not fetch any URL.

## Writing rules for code comments, tsdoc, test names, and the commit message

- Plain declarative sentences. Short. No em-dashes. No semicolons or colons inside a sentence.
- No metaphors. Say the literal thing. Banned examples include parked, stashed, in flight, kicks off, torn down, latch, gate, plumbed, threaded through, slot, and code that keeps, holds, carries, owns, pins, honors, or proves something. Say stores, uses, sets, checks, passes.
- Describe only the present. Never write still, now, no longer, used to, instead of, or as before in a comment or doc.
- Clauses after a noun keep their "that" or "which". No fragment-then-colon openers.
- A comment is one short sentence by default.
- The commit title is a short imperative phrase.

## Background

`ConvexReactClient` accepts `expectAuth: true` and `webSocketConstructor` in its options. `ConvexReactClientOptions` (`convex/react/client.ts`, line 304) extends `BaseConvexClientOptions` (`convex/browser/sync/client.ts`, `webSocketConstructor` at line 76 and `expectAuth` at line 139).

- `convex/react/client.ts`. `ConvexReactClient` builds its `BaseConvexClient` in the `sync` getter (line 391) on the first call that needs one. A `mutation`, a `setAuth`, or a query builds it. So no socket exists until one of those runs. `setAuth(fetchToken, onChange?, onRefreshChange?)` (line 440) passes a noop `onChange` when none is given. `clearAuth()` (line 464) calls `sync.clearAuth()`. `close()` (near line 780) awaits `sync.close()`.
- `convex/browser/sync/client.ts`. The `BaseConvexClient` constructor builds a `WebSocketManager` (line 418) and, when `expectAuth` is set, calls `pauseSocket()` as its last statement (line 528). `pauseSocket` calls `webSocketManager.pause()` and `state.pause()`. `setAuth` (line 668) calls `authenticationManager.setConfig`. `clearAuth` (line 690) sends one message and neither pauses nor resumes the socket. `enqueueMutation` (near line 916) calls `webSocketManager.sendMessage(message)` and passes the boolean result to `requestManager.request(message, sent)`. `close()` (line 1044) stops the authentication manager and calls `webSocketManager.terminate()`.
- `convex/browser/sync/web_socket_manager.ts`. The constructor calls `connect()` (line 252), and `connect()` (line 349) runs `new this.webSocketConstructor(uri)` at once. So the WebSocket object exists under `expectAuth` too. The pause marks the socket `paused: "yes"` (`pause()`, line 760) and stops messages. `connect()` assigns `ws.onopen`, `ws.onerror`, `ws.onmessage`, and `ws.onclose` as properties. It does not call `addEventListener` and does not read `readyState`. `sendMessage` (near line 520) sends only when the socket state is `ready` and `paused` is `"no"`, and returns false otherwise. The `onopen` handler (line 376) moves the socket to `ready`. When the socket is paused at that time it sets `paused: "uninitialized"` and skips the `onOpen` callback. `resume()` (line 820) runs the `onOpen` callback for an `uninitialized` socket, runs `onResume` for a `paused: "yes"` socket, and sets `paused: "no"` for a `connecting` socket. `close()` (near line 636) awaits the socket's `onclose` handler. For a `connecting` socket it waits for `onopen` before it calls `ws.close()`. `terminate()` (near line 685) clears its timers and then calls `close()`.
- `convex/browser/sync/request_manager.ts`. `request(message, sent)` (line 46) stores an unsent message with status `NotSent`. `restart()` (line 193, run from the `onOpen` callback) and `resume()` (line 232, run from `onResume`) return every `NotSent` message, and the base client sends them. So a mutation issued while the socket is paused is sent after the resume.
- `convex/browser/sync/authentication_manager.ts`. `setConfig` (line 150) pauses the socket, awaits the token fetcher with `forceRefreshToken: false`, and when no token comes back runs `refetchToken()` (near line 328) with `forceRefreshToken: true`. A second null reports `onAuthChange(false)` and resets the auth state. `setConfig` then calls `resumeSocket()` (line 185) whether or not a token came back. `stop()` (line 477) resets the auth state and does not touch the socket.
- `convex/react/ConvexAuthState.tsx`. `ConvexProviderWithAuth` (line 87) renders two child components around the `ConvexProvider`. `ConvexAuthStateFirstEffect` (line 172) calls `client.setAuth(fetchAccessToken, onChange, onRefreshChange)` with three arguments in an effect, when the `useAuth` hook reports authenticated. `ConvexAuthStateLastEffect` (line 233) calls `client.clearAuth()` in the cleanup of its own effect, when it rendered while authenticated.

So with `expectAuth: true` and a signed-out user, nothing calls `setAuth`, the socket is paused, and a sign-in mutation sent over it is stored as `NotSent` and never sent. Convex Auth signs in by sending a mutation over that socket.

The expected fix. The provider calls `client.setAuth(auth.fetchAccessToken, () => {})` once while signed out. The authentication manager fetches null twice, reports unauthenticated to the noop callback, and resumes the socket. The `NotSent` mutations are sent. When the user signs in, `ConvexAuthStateFirstEffect` calls `setAuth` again as it does today. When the user signs out, `ConvexAuthStateLastEffect` calls `clearAuth`, which does not pause.

A forced fetch with no refresh token makes no HTTP request. `browser/sessionManager.ts` `fetchAccessToken({ forceRefreshToken: true })` (line 434) runs the spa-mode refresh closure under `runWithMutex`, and that closure returns `{ kind: "noSession" }` when `#currentRefreshToken()` is null (line 209). `runWithMutex` (`browser/mutex.ts`) uses an in-process queue when `navigator.locks` is undefined, which is the case in jsdom.

## State of the branch after card 4

- `react/index.tsx` `ConvexAuthProvider({ client, auth, children })` builds the sign-in API wrapper with `useMemo` on `[client]`, calls `auth.setSignInApi(signInApi)` during render, and renders `<AuthProvider authClient={auth}><ConvexProviderWithAuth client={client} useAuth={useAuth}>`. It imports `ReactNode`, `useContext`, and `useMemo` from React. It has no effect of its own.
- `react/client.tsx` `AuthProvider` calls `authClient.init({ initialAccessToken })` in an effect on `[authClient]` and `authClient.dispose()` in that effect's cleanup. Child effects run before it. `useAuth()` returns a memoized `{ isLoading, isAuthenticated, fetchAccessToken }`, where `fetchAccessToken` is a `useCallback` on `[authClient]`. So `ConvexAuthStateFirstEffect` runs `setAuth` once per change of the authenticated flag.
- `browser/sessionManager.ts` `AuthClient` has `subscribe(listener)`, which returns an unsubscribe function, `getSnapshot()`, which returns `{ isLoading, isAuthenticated, token }`, and `fetchAccessToken({ forceRefreshToken })` as an arrow property. The forced path runs the refresh under a cross-tab mutex and returns null with no refresh token.
- `browser/storage.ts` exports `InMemoryStorage`, `NamespacedStorage`, `JWT_STORAGE_KEY` (`__convexAuthJWT`), and `REFRESH_TOKEN_STORAGE_KEY` (`__convexAuthRefreshToken`). `createAuthClient` wraps the given storage in `new NamespacedStorage(storage, storageNamespace ?? url)`.
- `react/index.test.tsx` has six tests under `describe("ConvexAuthProvider")`. `URL` is `https://happy-animal-123.convex.cloud`. `makeConvexClient()` returns `new ConvexReactClient(URL)` and `makeAuthClient()` returns `createAuthClient({ url: URL, api: API, storage: new InMemoryStorage() })`. `SIGN_IN` is `makeFunctionReference<"mutation">("auth:signInProbe")`. Every test that calls `auth.signIn` stubs `client.mutation` or `client.action` with `vi.spyOn`, so no `BaseConvexClient` and no socket exists in them. The file imports `render` and `waitFor` from `@testing-library/react`, `makeFunctionReference` from `convex/server`, `StrictMode` and `useEffect` from React, and `InMemoryStorage` from `../browser/storage.ts`.
- `components/email/react.test.tsx` seeds a session with `new NamespacedStorage(authStorage, NAMESPACE)` and two `set` calls, `JWT_STORAGE_KEY` to `"access-0"` and `REFRESH_TOKEN_STORAGE_KEY` to `"refresh-0"`. Copy that pattern.
- `KNOWN_ISSUES.md` at the repo root has one `##` heading per entry and names files by path.
- `packages/core/tsconfig.json` includes `src/**/*`, so the typecheck command covers the test files.

## Steps

Write the test first. Then the change. Keep whichever outcome the test supports.

Test, in `react/index.test.tsx`

- Define `class FakeWebSocket` with `static instances: FakeWebSocket[] = []`, a constructor that takes `url: string` and pushes `this` onto `instances`, a `sent: string[] = []` array, `onopen`, `onclose`, `onmessage`, and `onerror` properties typed as nullable functions and initialized to null, `send(data: string)` which pushes `data` onto `sent`, and `close()` which calls `this.onclose` when it is set. The socket manager assigns the four handlers as properties, so the fake needs no `addEventListener`. Clear `instances` in a `beforeEach`. Pass the class as `webSocketConstructor: FakeWebSocket as unknown as typeof WebSocket`, because the class does not match the full `WebSocket` type and the typecheck covers this file.
- Add a helper `open(socket)` that calls `socket.onopen?.(new Event("open"))`. The manager's `onopen` throws when the socket is not `connecting`, so call it once per instance.
- Add a helper `sentTypes(socket)` that returns `socket.sent.map((m) => JSON.parse(m).type)`. The first message after an open is `Connect`, then `ModifyQuerySet`, then the `NotSent` requests.
- Close every client at the end of its test with `void client.close()`. Do not await it. `terminate()` clears its timers before it waits for the close event, and a fake socket that never opened never fires that event.
- Case A, signed out. `new ConvexReactClient(URL, { expectAuth: true, webSocketConstructor })`, `makeAuthClient()`, `const setAuth = vi.spyOn(client, "setAuth")` that calls through, render the provider with a `<div />`. `await waitFor(() => expect(auth.getSnapshot().isLoading).toBe(false))`. Call `void auth.signIn.mutation(SIGN_IN, {})`. `await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))`, open that socket, then `await waitFor(() => expect(sentTypes(socket)).toContain("Mutation"))`. Also assert `setAuth` was called once and that its first argument is `auth.fetchAccessToken`. Before the change the mutation call builds the socket, the open leaves it `uninitialized`, nothing is sent, and the last `waitFor` fails. The test documents that.
- Case B, signed in. Build `const storage = new InMemoryStorage()`, seed it with `new NamespacedStorage(storage, URL)` as the email tests do, and pass it to `createAuthClient` with `url: URL` and `api: API`. Same client options as case A, spy on `client.setAuth`. `await waitFor(() => expect(auth.getSnapshot()).toMatchObject({ isLoading: false, isAuthenticated: true }))`. Then assert `setAuth` was called exactly once and that the call has three arguments. `ConvexAuthStateFirstEffect` passes an `onRefreshChange` function as the third argument and the provider's own call passes two arguments, so the argument count tells them apart.
- Case C, no `expectAuth`. Same as case A with `{ webSocketConstructor }` as the only option. Assert `"Mutation"` is sent after the open and that `setAuth` was called at most once. Before the change the count is zero and after it the count is one. The mutation is sent in both cases.

Change, in `react/index.tsx` only

- Import `useEffect`. Add an effect on `[auth, client]`. It subscribes to `auth` with a listener that reads `auth.getSnapshot()`, and it runs the listener once right after subscribing, because `init()` may have resolved before the effect ran, for example when the `client` prop changes after the session loaded. The first time a snapshot reports `isLoading: false`, the listener unsubscribes and, when `isAuthenticated` is also false, calls `client.setAuth(auth.fetchAccessToken, () => {})`. When the first settled snapshot is authenticated, it unsubscribes and calls nothing. The cleanup unsubscribes. One comment of at most two sentences states why. Under `expectAuth` the Convex client pauses its websocket until `setAuth` runs, and a signed-out user sends the sign-in mutation over that socket.

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

Tests that exist for those checks, found by name with grep. `oauth/react.test.tsx` has "StrictMode double mount redeems a callback code once", "the auth state never reports signed out while a callback code is redeemed", and "an ssr-mode client completes through its sign-in API and starts through the ConvexProvider client". `react/index.test.tsx` has "a new client prop sets the sign-in API again" and "a StrictMode double render sets one working sign-in API". `browser/createAuthClient.test.ts` has "the signInApi option sets the sign-in API". `browser/sessionManager.test.ts` has "signIn.mutation and signIn.action forward to the set API" and "withSignInPending entered before init reports loading past the session load". A grep over `packages/core/src` for `expectTypeOf` finds nothing, so the type inference check has no test. Confirm what each test covers with `grep -n -A 20` on its name, not by reading the files.
