# Card 1 of 5. Build the auth client outside React (single-page app half)

This is one commit in a five-commit series on branch `erquhart/oauth-client-simplify` in `get-convex/convex-auth`. The series moves auth client construction out of React, gives provider hooks one `useAuthClient()` hook, deletes the ambient sign-in plugin registry, and rebuilds OAuth as plain functions plus thin hooks. This card covers only the first commit. Do not start the later commits. Later cards cover the Next.js factory, the OAuth rewrite, the provider component cleanup, and `expectAuth` support.

Branch setup. `git fetch origin reboot`. If `erquhart/oauth-client-simplify` exists on the remote, check it out and continue from its head. Otherwise `git checkout -B erquhart/oauth-client-simplify origin/reboot`. Never push to `reboot`. Do not open a PR.

Read `AGENTS.md` at the repo root first. Relative imports in `packages/core/src` carry the on-disk extension (`./client.tsx`). Paths below are relative to `packages/core/src` unless they start with `examples/`.

## Working style, to keep your context small

- Read only the files named here, and use grep for call sites. Do not read whole large test files, read the harness part (imports and the render helper) and the tests you change.
- While iterating, run single test files with `pnpm vitest run packages/core/src/<file>`. Run the full `pnpm lint`, `pnpm -r --filter=!argon2id-wasm typecheck`, `pnpm build`, and `pnpm test` once, before committing.
- Do not paste whole files into your reasoning. Do not fetch any URL.

## Writing rules for code comments, tsdoc, test names, and the commit message

- Plain declarative sentences. Short. No em-dashes. No semicolons or colons inside a sentence.
- No metaphors. Say the literal thing. Banned examples include parked, stashed, in flight, kicks off, torn down, latch, gate, plumbed, threaded through, slot, and code that keeps, holds, carries, owns, pins, honors, or proves something. Say stores, uses, sets, checks, passes.
- Describe only the present. Never write still, now, no longer, used to, instead of, or as before in a comment or doc.
- Clauses after a noun keep their "that" or "which". Use short noun phrases ("the sign-in API"). No fragment-then-colon openers.
- A comment is one short sentence by default. Describe a layer once, at one place.
- The commit title is a short imperative phrase.

## Current code

- `browser/sessionManager.ts` is the `AuthClient` class. Constructor config is `{ mode: "spa" | "ssr", authApi, storage, storageNamespace, initialAccessToken?, ambientSignIns?: { signIns, signInApi }, verbose? }`. `#registerAmbientSignIns` runs ambient sign-in setups and passes them `signInApi`. `init()` runs the setups' `onInit` callbacks, writes `#initialAccessToken` to storage, then loads the session. `withSignInPending`, `setSession`, `signOut`, `fetchAccessToken`, `dispose` exist.
- `browser/ambientSignInClient.ts` defines `AuthSignInApi` (`mutation(fn, args)`, `action(fn, args)`), `AmbientSignInClient`, `AmbientSignInContext`. Leave this file in place. A later card deletes it.
- `browser/storage.ts` has `NamespacedStorage` with `forSignIn(id): SignInStorage`, `defaultStorage()`, `TokenStorage`, `SignInStorage`.
- `react/client.tsx` has `AuthProvider({ authClient, signInApi, children })` (calls `authClient.init()` in an effect, `dispose()` on cleanup), `useAuth`, `useAuthSignInApi` over `ConvexAuthSignInApiContext`, `AuthClientContext`, `ConvexAuthActionsContext`, `ConvexAuthTokenContext`.
- `react/index.tsx` has `ConvexAuthProvider({ client, api, storage, storageNamespace, ambientSignIns, children })`. Inside `useMemo` it builds a `ConvexHttpClient(client.url, { logger: client.logger })` for `refreshSession` and `signOut`, a `signInApi` wrapper over `client.mutation` and `client.action`, and `new AuthClient({ mode: "spa", ... ambientSignIns: { signIns: ambientSignIns ?? [oauth()], signInApi } })`. It renders `AuthProvider` around `ConvexProviderWithAuth`. It exports `useAuthActions`, `useAuthToken`, `useAuthSignInApi`, the Convex re-exports, and types.
- `nextjs/index.tsx` builds an ssr-mode `AuthClient` with `initialAccessToken: initialToken` and a proxy `signInApi`, and renders `<AuthProvider authClient signInApi>`. Only a minimal compile fix here in this card. The Next.js factory is the next card.
- Provider hooks that call `useAuthSignInApi()`: `components/password/react.tsx`, `components/anonymous/react.tsx`, `components/passkey/react.tsx`, `components/email/react.tsx`.
- Tests that render `<AuthProvider authClient signInApi>`: `components/{anonymous,password,passkey,email}/react.test.tsx`, `react/client.test.tsx`. `react/index.test.tsx` renders `ConvexAuthProvider` with `api` and `ambientSignIns`. `oauth/testFlow.ts` `oauthClient()` builds an `AuthClient` with `ambientSignIns: { signIns: [oauth()], signInApi }`. `react/testSignInApi.ts` has `stubSignInApi()`.
- SPA examples that render `ConvexAuthProvider`: `examples/react-minimal`, `react-password`, `react-passkey`, `react-passkey-basic`, `react-github`, `react-google`, `react-apple`, each in `src/main.tsx`.

## Target of this commit

```ts
// browser, re-exported from @convex-dev/auth/react
const auth = createAuthClient({ url, api, storage?, storageNamespace?, logger?, verbose?, signInApi? });
auth.setSignInApi(api: AuthSignInApi): void;
auth.signIn.mutation(ref, args); auth.signIn.action(ref, args);   // forward to the set API
auth.signInStorage(id: string): SignInStorage;
await auth.init({ initialAccessToken? });

<ConvexAuthProvider client={convex} auth={auth}>…</ConvexAuthProvider>
useAuthClient(): AuthClient
```

Behavior does not change in this commit. The ambient system keeps running, through `auth.signIn`.

## Rules that must hold

1. The SPA provider sets the sign-in API during render, not in an effect. React runs child effects before parent effects, and provider hooks call `auth.signIn` from mount effects, so the API has to be set before the provider's own effects run. The call is an idempotent assignment.
2. `init()` stays idempotent after its first call and re-attaches the storage listener on every call.
3. `withSignInPending` entered before `init()` resolves keeps `isLoading` true past the session load. Keep the existing test for this.

## Steps

`browser/sessionManager.ts`

- Add `#signInApi: AuthSignInApi | null = null`, `setSignInApi(api: AuthSignInApi): void`, and `readonly signIn: AuthSignInApi` whose `mutation` and `action` forward to `#signInApi`. When none is set, throw `new Error("[convex-auth] No sign-in API is set on this AuthClient. Render it with ConvexAuthProvider or ConvexAuthNextjsProvider, or call setSignInApi(convexClient) first.")`.
- Add `signInStorage(id: string): SignInStorage` returning `this.#storage.forSignIn(id)`. Validate `id` with `/^[a-zA-Z0-9]+$/` and throw on failure, with the same message `#registerAmbientSignIns` uses for an invalid id.
- Change `init()` to `init(options?: { initialAccessToken?: string | null })`. Remove `initialAccessToken` from the config and remove the `#initialAccessToken` field. The token is written to storage before the load, as the existing code does.
- Change the `ambientSignIns` config to `ReadonlyArray<AmbientSignInClient>`. `#registerAmbientSignIns` passes `signInApi: this.signIn` to each setup. Update the config tsdoc.

`browser/createAuthClient.ts` (new) and `browser/index.ts`

- `export type CreateAuthClientOptions = { url: string; api: ConvexAuthApi; storage?: TokenStorage; storageNamespace?: string; logger?: Logger; verbose?: boolean; signInApi?: AuthSignInApi; ambientSignIns?: ReadonlyArray<AmbientSignInClient> }`. `ConvexAuthApi` is in `lib/types.ts`. `Logger` is exported by `convex/browser`.
- `createAuthClient(options): AuthClient`. Build `new ConvexHttpClient(options.url, { logger: options.logger })`. Construct the spa-mode `AuthClient` with `refreshSession: (refreshToken) => httpClient.mutation(api.refreshSession, { refreshToken })` and `signOut: async (refreshToken) => { await httpClient.mutation(api.signOut, { refreshToken }); }`, `storage: options.storage ?? defaultStorage()`, `storageNamespace: options.storageNamespace ?? options.url`, `ambientSignIns: options.ambientSignIns ?? [oauth()]`, `verbose`. Call `setSignInApi` when `signInApi` is given.
- Move the comment that explains the separate HTTP client here, in one sentence. The websocket is paused during the token handshake, so a refresh over it would deadlock. Remove that comment from `react/index.tsx`.
- Export `createAuthClient` and `CreateAuthClientOptions` from `browser/index.ts`.

`react/client.tsx`

- Remove `ConvexAuthSignInApiContext` and `useAuthSignInApi`.
- Add `export function useAuthClient(): AuthClient` reading `AuthClientContext`. Throw outside a provider with a message that names `ConvexAuthProvider` and `ConvexAuthNextjsProvider`.
- `AuthProvider({ authClient, initialAccessToken?, children })`. The init effect calls `authClient.init({ initialAccessToken })`. Remove the `signInApi` prop and its context provider.
- Update the `useAuthActions` tsdoc in `react/index.tsx` to say provider code uses `useAuthClient()`.

`react/index.tsx`

- `ConvexAuthProvider({ client, auth, children })` with `auth: AuthClient`. Build the wrapper once per client with `useMemo(() => ({ mutation: (fn, args) => client.mutation(fn, args), action: (fn, args) => client.action(fn, args) }), [client])` and call `auth.setSignInApi(wrapper)` during render, on every render. One comment states rule 1.
- Remove the `api`, `storage`, `storageNamespace`, and `ambientSignIns` props and the `useMemo` that built the client. Render `<AuthProvider authClient={auth}><ConvexProviderWithAuth client={client} useAuth={useAuth}>`.
- Exports: add `createAuthClient`, `type CreateAuthClientOptions`, `useAuthClient`, `type AuthClient`, keep `type AuthSignInApi`. Remove the `useAuthSignInApi` export. Rewrite the module tsdoc example so it builds `convex` and `auth` at module scope and renders `<ConvexAuthProvider client={convex} auth={auth}>`.

`nextjs/index.tsx`, minimal compile fix only

- Replace `initialAccessToken: initialToken` in the constructor config with `<AuthProvider authClient={authClient} initialAccessToken={initialToken}>`.
- Call `authClient.setSignInApi(signInApi)` inside the existing `useMemo` after building the proxy `signInApi`, and drop the `signInApi` prop from `AuthProvider`.

Provider hooks, mechanical only

- In `components/password/react.tsx`, `components/anonymous/react.tsx`, `components/passkey/react.tsx`, `components/email/react.tsx`: replace `const signInApi = useAuthSignInApi();` with `const signInApi = useAuthClient().signIn;` and fix the imports. Change nothing else in these files.

SPA examples

- In each `src/main.tsx`: `const auth = createAuthClient({ url: import.meta.env.VITE_CONVEX_URL, api: api.auth });` at module scope, carrying over any `storage` or `storageNamespace` prop the example passes today, and render `<ConvexAuthProvider client={convex} auth={auth}>`. Check each file for the env variable name it uses.

## Tests

- `browser/sessionManager.test.ts`: add tests for `setSignInApi` and `signIn` forwarding (both methods), the unset error message, `signInStorage` id validation and key scoping (keys are `__convexAuthProvider_<id>_<key>` before the namespace suffix). Move the `initialAccessToken` tests to `init({ initialAccessToken })`. Adapt the ambient describe to the array config. Keep the test "a withSignInPending call in onInit holds loading past the session load".
- `browser/createAuthClient.test.ts` (new): `refreshSession` and `signOut` post through an HTTP client to the given function paths (stub `globalThis.fetch` with `vi.stubGlobal` and assert the request path and body), `storageNamespace` defaults to `url`, the `signInApi` option sets the API so `auth.signIn.mutation` reaches it.
- `react/client.test.tsx`: drop `signInApi` from the harness. Add: `useAuthClient` throws outside a provider, returns the client inside, `AuthProvider` passes `initialAccessToken` to `init`.
- `react/index.test.tsx`: render `<ConvexAuthProvider client={client} auth={auth}>` with `auth` from `createAuthClient` (pass `ambientSignIns` through the option where a test registers a probe). Rewrite "the sign-in api routes through the Convex client" as `auth.signIn.mutation` reaching `client.mutation` (spy on `client.mutation`). Add: a child component's mount effect can call `auth.signIn.mutation` without the unset error. Add: changing the `client` prop re-sets the API (the second client's `mutation` spy is hit). Add: a StrictMode double render is safe (one setup, one working API).
- `components/{anonymous,password,passkey,email}/react.test.tsx`, `oauth/react.test.tsx`, `oauth/testFlow.ts`: call `client.setSignInApi(signInApi)` before rendering and render `<AuthProvider authClient={client}>`. In `testFlow.ts` the config becomes `ambientSignIns: [oauth()]` plus `setSignInApi`.

## Verification, then commit and push

```sh
pnpm install
pnpm lint
pnpm -r --filter=!argon2id-wasm typecheck
pnpm build
pnpm test
```

All four must pass. Commit once with the title `Build the auth client outside React` and a short body that lists the new API and says behavior does not change. Push with `git push -u origin erquhart/oauth-client-simplify`.

## Final message

List the files you changed, the tests you added, anything you did differently from this card and why, and anything the next card has to know (helper names, a moved comment, an example that needed something extra). The next card is written from your report. Do not write the next card yourself.

Write the same report to `plans/oauth-client-simplify/report-1.md` and include it in your commit, so the next planner session can read it from the branch.

After the push, spawn the next planner session as a task card with exactly this prompt and the title `Planner: next card`. "Check out the branch `erquhart/oauth-client-simplify` in `get-convex/convex-auth`, read `plans/oauth-client-simplify/PLANNER-PROMPT.md`, and follow it." If your session has no task card tool, end your final message with that sentence so a person can start the planner from it.
