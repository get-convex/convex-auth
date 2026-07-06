# convex-auth — Architecture & Code-Quality Audit (vNext)

**Scope:** full working tree of `packages/auth` (component + server + client + docs + packaging), audited against the design bar set by the sibling Convex components `../stream` and `../agent`.
**Method:** 7 parallel domain auditors (Opus). Every finding cited below was verified against the working tree; the two CRITICALs and the highest-severity HIGH/docs findings were independently re-verified by the orchestrator (file:line confirmations noted inline).
**Excluded by design (NOT findings):** grant-intersection scope enforcement, whole-session revocation on refresh-reuse, OAuth-tokens-are-Convex-identities, opaque hash-only refresh tokens, bounded `connection.remove` cascade, server-side SSRF guard, redacted-vs-raw SAML SP key, hand-edited `_generated/component.ts`, the api-type-cycle inline-definition constraint, and the `auth`-type inference-depth ceiling.

---

## Completion status (2026-07-06)

Implemented across 6 sequential/parallel agent waves, verified green at every boundary. **Final state: convex 348 + node 48 tests pass; all typecheck projects (server/client/component/consumer-source/consumer-dist/tests) 0 errors; fmt clean; dist rebuilt. Uncommitted.**

**DONE:** C1, C2, H1–H10, H12–H16, R1, R3–R6, M1, M3, and every MEDIUM/LOW item except where noted below.

**DEFERRED — H11 (boundary-wrapper unification):** implemented and passing source typechecks, but reworking the boundary/ctx types tips the `auth`-type TS inference-depth ceiling (an _excluded-by-design_ constraint) when resolved through the expanded dist `.d.ts`, breaking `consumer:dist`. Reverted to keep the tree green. Needs a depth-aware redesign. The wire-shape drift it targeted (`ScimConfigRecord.tokenHash` vs `vConnectionScimConfig.hasToken`) remains a latent type-inconsistency, not an active bug.

**Behavior changes to review (operator-visible):** SSO login now authoritatively shrinks connection-owned roles (H4); SAML rejects SHA-1/RSA-1.5/3DES by default, opt-out `weakAlgorithmHandling:"warn"`; unverified domains no longer resolve for routing (H1); TOTP secrets encrypted at rest (pre-existing plaintext enrollments need re-enrollment — pre-1.0, no in-place migration); OTel packages → optional peerDependencies; `auth.http` shadow-router delegate deleted (verified not load-bearing).

**H8 note:** `password.changed` was already emitted from `providers/password.ts` (the original "emitted nowhere" was scoped to `server/`); only `api_key.revoked` + `session.invalidated`-on-replace were the real gaps, now fixed.

**Still interop-only (test gaps):** SAML ACS full flow (needs an injectable-clock seam + Docker interop), framework hooks (need jsdom/testing-library), SCIM HTTP layer, webhook signature scheme.

---

## Executive summary

The codebase is, on the fundamentals, at or above the stream/agent bar: return-validator coverage is ~100%, LEXICON verb discipline is near-perfect, comment discipline holds, event-sourcing atomicity is real, layering has zero upward imports from deep modules, crypto hygiene (constant-time compares, hash-only lookups, AES-GCM secret box, log redaction) is strong, and the OAuth IdP / refresh / OIDC-RP paths are rigorous and well-tested.

The gaps cluster into a small number of **cross-cutting themes**. The most serious is a **security cluster in the enterprise-connection vertical** — the system repeatedly trusts external assertions/claims without applying proofs its own code can already produce, and the enforcement primitives exist but aren't wired to the decision path. The rest are **maintainability debt** where the code has drifted below the stream/agent bar: hand-mirrored type shapes with three sources of truth (already drifting), duplication-as-architecture in the client/factor/composition layers, and a set of unbounded reads/growth spots that are inconsistent with the codebase's own otherwise-strong bounding discipline.

Nothing here questions the intentional design decisions. Most HIGH items are small, surgical fixes; the largest lift is test coverage.

---

## Cross-cutting themes (ranked)

**A. Trust-without-proof in the connection vertical (security).** SAML replay, unenforced domain verification, fabricated `emailVerified`, de-provisioning that doesn't revoke, additive-only SSO sync — all share one root: assertions/claims are trusted without the proof the code can produce (DNS-TXT verification exists; session-revoke primitives exist; `OAuthCode.usedAt` consumption exists) but isn't called on the connection path. Fixing the theme = wiring existing machinery into enforcement.

**B. Bounded-read discipline has holes.** The codebase has a strong bounding culture (`CASCADE_MAX`, `.take()`, self-rescheduling drains). A few spots escaped it: an unbounded webhook-delivery table, the group re-parent cascade, a non-rescheduling pruner. High-signal precisely because they're inconsistencies with the code's own hardening.

**C. Three-sources-of-truth for shapes.** Wire shapes are hand-mirrored across component validators, `contract.ts` TS records, and `validators.ts` return-validators — and have _already drifted_ (`ScimConfigRecord.tokenHash` vs `vConnectionScimConfig.hasToken`). Same class: `vUserPatchData` copy of `vUserInsertData`, event-kind lists duplicated across ~5–8 sites. The agent codebase's `Infer<typeof v>` / `partial(pick(schema…))` pattern eliminates this by construction.

**D. Duplication-as-architecture in adapters/factors/boundary.** Client platform adapters (`browser/`, `expo/`) re-assemble the core instead of layering over it; the two passkey clients are ~90% duplicated and drifting; the two server factor drivers share no abstraction; three parallel component-boundary wrappers do the same job three ways. The stream/agent bar is one core + thin adapters.

**E. Shadow/duplicated infrastructure in the composition roots.** `runtime.ts` carries a vestigial second HTTP router whose route table has already drifted from the real one; the HTTP surface has three JSON error shapes and two CORS implementations.

**F. Audit-log completeness.** The audit log is the product's read model and security surface, yet password-change, key-rotation, session-replace, and SCIM-token-rotation are invisible or indistinguishable.

**G. Test coverage.** Zero offline coverage for passkeys, TOTP, every client adapter, and provider config; SAML/SCIM/webhooks are interop-only or config-only.

---

## CRITICAL

### C1 — SAML assertion replay is unprevented

`server/connection/http.ts:631-779` (ACS handler), `server/connection/saml.ts:168-212` (`encodeGroupSamlRelayState`), `saml.ts:1140-1152`.
RelayState is a **stateless base64url JSON blob round-tripped through the browser**; there is **no server-side pending-request store and no seen-assertion-ID cache** (the `request_id_time` index at `component/schema.ts:479` is on the audit-event table, not a consumption record). The ACS handler binds `relayState.requestId === subjectConfirmation.inResponseTo` — but both values travel in the same POST, so **replaying a captured `SAMLResponse`+`RelayState` pair passes every check** and mints a fresh session on each replay, within the assertion's `NotOnOrAfter` window (default skew 300s + IdP lifetime). This directly contradicts the OAuth path, which stamps `OAuthCode.usedAt` (`component/oauth/code.ts:69-77`).
**Fix:** persist AuthnRequest IDs as pending rows, consume-on-use (reject an `InResponseTo` with no unconsumed row), and keep a short-lived assertion-ID replay cache bounded by `NotOnOrAfter`.

### C2 — `GroupWebhookDelivery` grows unbounded

`component/schema.ts:511-532`, `component/maintenance.ts` (`pruneExpired` reaps 8 tables — Session/RefreshToken/VerificationCode/AuthVerifier/GroupInvite/DeviceCode/OAuthRefreshToken/OAuthRefreshGrant — **not** `GroupWebhookDelivery`), `component/crons.ts`.
Every delivered event on every endpoint inserts a permanent row storing the full `payload` (`v.any()`) + `signature`; nothing reaps it. A busy connection accumulates rows forever — the exact unbounded-growth class the codebase treats as a hard rule elsewhere.
**Fix:** add a terminal-status/`signedAt`-indexed prune to `pruneExpired` (delete `delivered`/`failed` older than N days), mirroring OAuth-grant reaping.

---

## HIGH — security & correctness

### H1 — Domain claim is proof-free and never enforced at resolution

`component/connection.ts:48-61` (by-domain resolver does `.withIndex("domain", …).first()` with **no `verifiedAt` filter**), `component/connection/domain.ts:40-98` (claim needs no proof), `component/schema.ts:366` (`domain` is a non-unique index).
A real DNS-TXT ownership proof exists (`server/connection/domain.ts:181-206,714-739`) but nothing on the login/linking path reads `verifiedAt`. Org B can attach `victim-corp.com` with zero proof and route those users to its IdP (for apps doing email-domain→connection discovery, the pattern the migration guide shows).
**Fix:** filter `getGroupConnectionByDomain` to `verifiedAt != null`; require verification before a domain influences routing/linking; back `domain` with real uniqueness.

### H2 — SAML fabricates `emailVerified: true` for any asserted email

`server/connection/saml.ts:1247` (`emailVerified: typeof email === "string" ? true : undefined`) → `server/user/account.ts:342-349`. OIDC correctly reads the real claim (`oidc.ts:277-281`).
Safe under the **default** policy (`accountLinking.saml: "sameConnection"`, `policy.ts:9`), but under `identity.accountLinking.saml: "verifiedEmail"` a malicious/misconfigured IdP asserting `email: victim@othercorp.com` links to any existing local user with that email, cross-connection.
**Fix:** SAML `emailVerified` must be `false` unless the email's domain is a verified connection domain; gate/reject `"verifiedEmail"` for SAML.

### H3 — De-provisioning never revokes sessions or refresh tokens

`server/connection/http.ts:1418-1460` (SCIM `DELETE /Users`), `server/domains/member.ts:367-371` (`member.remove`).
SCIM delete removes the `GroupMember` / flags `active:false` but calls no session or refresh-token revocation, though `deleteSession`/invalidate exist (`server/session/lifecycle.ts`). An offboarded employee's live session cookie and long-lived refresh token stay valid until natural expiry — SSO admins universally assume SCIM DELETE terminates access.
**Fix:** on SSO-owned membership removal, enumerate `Session by user_id` (bounded) + revoke; emit `session.revoked`.

### H4 — SSO/JIT membership sync is additive-only (privilege retention)

`server/mutations/oauth.ts:79-116` (`jitProvisionMembership`, esp. the `else if (provisionedRoleIds.length > 0)` guard at :110).
SSO login creates/overwrites `roleIds` but never removes a membership, shrinks roles, or deactivates. A user demoted or removed from a group at the IdP keeps local privileges indefinitely; SSO has no de-provision trigger (only explicit SCIM does), so the two mechanisms disagree on whether the IdP is authoritative.
**Fix:** make SSO group/role claims authoritative for connection-owned memberships (reconcile-to-set), or document SSO-additive + SCIM-required-for-deprovision.

### H5 — SCIM authoritative membership sync runs over a silently-truncated read

`server/connection/http.ts:250` (`SCIM_COLLECT_LIMIT=5000`), `:895-921` (truncation only WARNs), `:1620-1644`,`:1739-1774` (Group POST / PATCH-`replace` diff).
Full-sync `replace` computes `currentMembers` via the ≤5000-capped collect, then removes anyone not in the incoming set. On a >5000-member group the enumeration is partial, so the destructive diff fails to remove overflow members (and pagination past 5000 is wrong) while returning `200`. A truncated read driving a destructive write.
**Fix:** fail the reconcile (413/500) rather than complete a partial authoritative replace; or paginate the diff fully.

### H6 — `group.update` re-parent cascade is unbounded

`component/group.ts:256-277`. When `patch.parentGroupId` changes the subtree's `rootGroupId`, the handler BFS-walks all descendants via unbounded `getManyFrom(...)` per level and `ctx.db.patch`es every descendant **in one mutation** — while the sibling `group.remove` (`group.ts:294-339`) bounds every level with `.take(CASCADE_MAX+1)` + `CASCADE_TOO_LARGE`. Re-parenting a large subtree exceeds per-transaction limits and rolls back.
**Fix:** apply the same `.take(CASCADE_MAX+1)` guard, or make the `rootGroupId` re-stamp a self-rescheduling continuation (idempotent, safe to resume — agent's `deleteAllForThreadIdAsync` pattern).

### H7 — `maintenance.pruneExpired` is a public `mutation` (destructive bulk-delete over-exposed)

`component/maintenance.ts:27`, on the public surface at `_generated/component.ts:3275`, only caller is the cron (`crons.ts:13`). Crons can reference `internal.*` (proven two lines down: `crons.ts:20` uses `internal.event.drainPending`). As written, any consumer of the auth component can invoke an unauthenticated, unthrottled bulk-delete across 8 tables.
**Fix:** make it `internalMutation` and reference `internal.maintenance.pruneExpired`. (Also: it doesn't self-reschedule, so a backlog >batchSize drains one batch per day — add `scheduler.runAfter(0, …)` when a per-table count hits `batchSize`.)

### H8 — Security-relevant mutations emit no audit event

`server/events.ts:39` declares `password.changed` with a full handler wiring, but it is **emitted nowhere** (`modifyAccountImpl`, `mutations/account.ts:18-45`, returns `void`); `domains/account.ts:152-158` (password reset) is the same silent path. `key.rotate` (`domains/key.ts:344-375`) sets `revoked:true` on the old key inline without emitting `api_key.revoked`. Session replacement (`component/session.ts:56-70`) deletes the old session silently.
The audit log is the product's security-review surface; password reset and key rotation are exactly what an incident responder searches for, and they're invisible.
**Fix:** emit `password.changed` from `modifyAccountImpl` (with `flow: "reset"|"change"`), `api_key.revoked` on rotate, and a `session.invalidated`/`session.replaced` on replace.

### H9 — Passkey verification has zero rate limiting

`server/passkey.ts:465-543` (`handleAuthVerify`) performs no `isSignInRateLimited`/`recordFailedSignIn`, while `totp.ts` (lines 292/319/365/381), `mutations/retrieve.ts`, `mutations/credentials/signin.ts`, and `mutations/verify.ts` all throttle. Credential-enumeration / unbounded verification attempts against `queryPasskeyByCredentialId` are unthrottled and asymmetric with every other factor.
**Fix:** add TOTP-parity rate limiting to the passkey verify path (folds naturally into the shared factor core — see H13).

---

## HIGH — architecture & maintainability

### H10 — `types.ts` is a 1608-line god module (fan-in 66) mixing three concerns

`server/types.ts` — the single most-imported module in the package — holds (1) legit spine config types, (2) **19 runtime cross-component wrapper _functions_** (`queryUserById`, `mutateTotpInsert`, … lines 1387-1608) used by only 4 files, and (3) inferred doc aliases. A `types.ts` shipping `ctx.runMutation(...)` calls violates least-surprise, and 66 modules recompile on any change.
**Fix:** split into pure `types.ts` + `server/component/factor-db.ts` (the totp/passkey/device wrappers), mirroring agent's `validators.ts`-vs-`execution.ts` separation.

### H11 — Three parallel component-boundary wrappers; three sources of truth for wire shapes (already drifted)

`server/db.ts` (`authDb`), `server/contract.ts` (`componentQuery` + hand-typed `Record`s), and `server/types.ts` (`queryUserById`…) each re-implement "cast the ref, cast the result" with different mechanisms, ctx typings, and cache behavior. Compounding it, the same entity is hand-declared three times — and `contract.ts` `ScimConfigRecord` (has `tokenHash`) already disagrees with `validators.ts` `vConnectionScimConfig` (has `hasToken`/`security`/`profile`, no `tokenHash`). The correct pattern already exists in-repo: `server/component/api.ts` `AuthComponentApi = ComponentApi<"auth">` keeps args/returns intact.
**Fix:** collapse to one boundary module built on `AuthComponentApi` with a single generic `runQuery`/`runMutation`; rebuild `contract.ts` shapes as `Infer<typeof componentValidator>`; derive public `auth.v.connection.*` from the component doc validators. Collapses the ctx-type zoo and both `bridge*<T>` escape hatches (`facade.ts:316`, `runtime.ts:90`) too.

### H12 — `runtime.ts` shadow HTTP router + vestigial `httpDelegate`

`server/runtime.ts:115-171,432-474,738-769`. A hand-rolled second router (`createInMemoryHttpRouter`, `invokeHttpHandler` reaching into Convex-internal `handler._handler`, `createProtocolRouter`, `httpDelegate`) with **zero callers**, whose route table has **already drifted**: `createProtocolRouter` calls `addOpenIdRoutes` with no `oauth` block/`routeBase` and never calls `addOAuthProviderRoutes`, so the delegate's discovery doc omits the OAuth endpoints and it serves none. Two route tables, one wrong; depends on an undocumented Convex internal.
**Fix:** delete the delegate + in-memory router (~130 LOC) if the generated-API-compat shim is truly unused (verify no codegen/downstream dependency first), or route it through the real `request.add` so there is one route table. Separately extract `createOAuthHttpHandlers` + the unlink helpers out of the 959-line factory.

### H13 — Client & server duplication-as-architecture

- **Platform adapters re-assemble the core:** `browser/index.ts` and `expo/index.ts` duplicate `inferConvexUrl` byte-for-byte (browser 148-170 ≡ expo 229-251), repeat the `createClient({...})` block, manually re-list every client method, and call `initialize()` a second time (core already calls it at construction, `client/index.ts:1198`). The hooks they inject (`runtime.oauth`) are already injected into the core.
- **Two passkey clients ~90% duplicated and drifting:** `browser/passkey.ts` (290) vs `expo/passkey.ts` (272) share `handleSignedInResult` + phase-1/2 flow near-verbatim; the only real delta is the ~40-line WebAuthn ceremony. Already drifting (`as` vs `satisfies`; different `rawId` handling → different field encodings sent to the same server verifier).
- **Two server factor drivers share no abstraction:** `passkey.ts` and `totp.ts` each redefine `requireAuthenticatedUserId` and `convexError`/`asConvexError` (twice, near-identically) and re-implement flow dispatch + verifier lifecycle.
  **Fix:** move OAuth-launch/URL-cleanup into `client()` driven by `runtime.oauth`; adapters pass options and spread the core client. Extract `client/factors/passkey.ts` with a `{ceremony}` hook (~200 lines removed). Extract a server `factor/` core (shared `requireFactorVerifier`, one `convexError`).

### H14 — HIGH docs bugs that fail at call time

- **`auth.group.active.set` / `.clear` do not exist** — `docs/src/routes/api/user/+page.md:42-43,97-102` vs `server/core.ts:219,267,298` where the verbs are `get`/`update`/`remove`. Copying the doc is a runtime `TypeError`. (Source JSDoc `core.ts:216-217` also mislabels them.)
- **`http: { prefix }` is silently ignored** — `docs/src/routes/reference/config/+page.md:77-79,95` vs the real top-level `path?: string` (`types.ts:179`, consumed `runtime.ts:231` as `config.path ?? "/auth"`). No `http` config object exists.
  **Fix:** `set/clear`→`update/remove`; `http.prefix`→`path`.

### H15 — OTel SDK packages are unconditional runtime deps, 3 of them type-only

`package.json` ships 8 `@opentelemetry/*` runtime deps reachable only via the opt-in `/otel` entry (`src/otel.ts`); nothing in `/server`,`/client`,`/react`,`/core` re-exports it. `otel.ts:14-16` imports `sdk-logs`,`sdk-metrics`,`sdk-trace-base` as `import type` (erased at build) yet they're runtime deps. Against the stream/agent bar (≈1 runtime dep; framework concerns are optional peers), a `/server`-only consumer installs the whole OTel tree.
**Fix:** move the 3 type-only pkgs to devDeps; make the 4 value pkgs optional peers gated on `/otel`. (Also: the `@comment devDependencies` note is factually wrong — it claims Effect deps; the CLI actually uses `@clack/prompts`/`figlet`/`gradient-string`.)

### H16 — Zero offline tests for the DX surface; SAML/SCIM/webhooks under-covered

No test imports `src/react`, `src/svelte`, `src/expo`, `src/browser`, constructs a provider factory to assert emitted config, or exercises passkey/TOTP flows. SAML is interop-only (happy path); SCIM is config-only; webhook delivery/retry is untested. The connection auditor identified the exact seams blocking offline SAML tests: `flow.ts` welds verify+extract+time-check and rejects with bare string literals; `validator.ts:9` uses `new Date()` (no injectable clock); `api.ts:65-78` caches the DOM parser in a module singleton.
**Fix:** thread an injectable `now`/`clock` + typed errors through `flow.ts`/validators and expose `createSamlContext({parser})`; then add offline fixtures for the 5 highest-value SAML tests (signature-stripping/XSW, clock-skew boundaries, duplicate-ID/wrapped assertions, decrypt failures, rejection paths). Add a jsdom `tests/adapters/*` layer + `tests/providers.test.ts`, and a shared `tests/support/` fixture (mirrors `stream/src/testing`).

---

## MEDIUM

- **TOTP secrets stored plaintext at rest, in two places** — `totp.ts` writes the raw secret to `TotpFactor.secret` _and_ JSON-serializes it into `AuthVerifier.signature` (`totp.ts:232`), though `secret.ts` `encryptSecret` (AES-GCM) is used for connection/webhook secrets. Encrypt it; stop smuggling the raw secret through the verifier (re-read the factor row in `confirmEnrollment`).
- **Adding an event kind is an 8-site change** and the kind list is duplicated across `server/events.ts` (union :29, `AuthEventDataByKind` :187, handler map :355, `EVENT_KIND_CATEGORY` :540, selectors :670, refs :811) and independently in `component/model.ts:201` (`vAuthEventKind`) — server↔component drift is unguarded. Define kinds+categories once as a const table; derive the union, category map, and `v.union` validator from it; share across server/component.
- **Three JSON error-body shapes on one HTTP surface** — `{error,error_description}` (RFC, correct), `{error,code}` (`http.ts:442,485`), `{code,message}` (`http.ts:635,1041`). Unify non-OAuth responses behind one `jsonError(status,{code,message})` + one `convexErrorToBody()`; keep a named `oauthError()` for RFC endpoints.
- **Two CORS implementations with divergent allow-lists** — `cors.ts` (`Allow-Origin: *`) vs `http.ts:185 buildCorsHeaders` (origin-matched), two preflight paths. Fold into one policy-object module (permissive-bearer vs origin-matched-credentialed). (CONVEX-HELPERS-ADOPTION claimed CORS was "well-factored"; it's factored twice.)
- **`services/*` is a stateless pass-through tier** — `services/{signin,refresh,logger}.ts` forward unchanged, and `signInImpl`→`signInFx` adds a second hop, so the chain is `runtime → services.signIn.signIn → signInImpl → signInFx → handler`. Delete the tier; import the impls directly. Neither stream nor agent has a service-object layer.
- **`*Fx` internal-verb suffix** (`signInFx`, `handleCredentialsFx`, …) isn't in the LEXICON verb set and is applied inconsistently (`handlePasskeyFx` vs `handleTotp`). Drop it.
- **SHA-1 SAML signatures accepted by default** — `saml.ts:1069-1132` defaults `weakAlgorithmHandling` to warn, not reject; `xmldsig.ts:152` defaults SHA-1. Secure-by-default should reject SHA-1 on the verification path (the code already makes the analogous choice for `requireTimestamps`).
- **SCIM PATCH/DELETE bypass the SCIM error-schema wrapper** — `http.ts:1083-1095` registers them without `connectionRouteHandler`, so an unrecognized error escapes as a raw 500 instead of the RFC-7644 `2.0:Error` schema. Route all SCIM methods through the same wrapper.
- **SCIM filter/PATCH surface is limited but advertised as full** — only `eq,co,sw,ew,pr` (no `and/or/ne/gt…`), PATCH `path` is a case-sensitive string ladder, `ServiceProviderConfig` advertises `filter.supported:true`/`patch.supported:true`. Low real-world risk (Okta/Azure use `eq`), but non-conformant. (Filter regexes are anchored — no ReDoS; values never enter a query — no injection.)
- **Two divergent SAML metadata parsers** (`saml.ts:276` regex-based vs `metadata.ts` DOM-based) and **three identity-mapping paths** (OIDC/SAML/SCIM) — the email-verification trust rule has to be fixed in three places and has already drifted. Centralize `normalizeIdpProfile({protocol,raw,mapping})`; one metadata parser.
- **`convexError(code: string)` defeats the ErrorCode registry** — `errors.ts:16` + `AuthErrorData.code: string` means consumers can't exhaustively switch and LEXICON §4a's compile-time-typo guarantee is unenforced. Type it `code: ErrorCode`.
- **`facade.ts` ↔ `context.ts` value-import cycle with inverted ownership** — `facade.ts` (fan-in 0) defines the core domain types while `context.ts` owns the resolver and imports its return types back from the "facade." Move `AuthContext`/etc. to a types leaf.
- **No typed error surface for client UI** — `AuthState` has no error variant; `ErrorCode` is never surfaced on any client return; TOTP `confirm`/`verify` return `void` on non-completion (`totp.ts:116,137`) and browser maps any non-`signedIn` to `{kind:"started"}`. The taxonomy is also split (`client/errors.ts` local consts vs `shared/codes.ts`). Surface `{code: ErrorCode}` typed failures.
- **Proxy retry classification is regex-over-error-message** — `client/runtime/proxy.ts:1,24` formats an HTTP status into a string then regex-parses it back out; an i18n'd fetch error silently breaks refresh retry. Carry `{status}` structurally.
- **Dead `rateLimitState` threading** — `limits.ts` `recordFailedSignIn`/`resetSignInRateLimit` ignore `_state`; `getSignInRateLimitState`/`isStateRateLimited` are a no-op kept "for back-compat" but threaded through 6 call sites. Delete (~30 lines).
- **CI/release gaps** — `release.yml:31-40` publishes on tag with **no test run**; `fmt:check`, `spellcheck` (whose glob `docs/pages/**` matches nothing — real path is `docs/src/routes/**`), and `check:component-paginate` (guards a real runtime invariant) are wired into no workflow; `typecheck:consumer` resolves the package to **source not dist**, so a broken `.d.ts` emit ships undetected. Wire them in; add a dist-resolved consumer typecheck.
- **MEDIUM docs drift** — `MIGRATION-vNext.md:73,104` uses `data:` where the arg is `patch:` (contradicts its own LEXICON §1 and the passing `consumer/types.ts` contract); `connection/{saml,scim,oidc}` tables call the verb `configure` where source is `set`; `reference/cli` documents only `setup` (source has `setup`/`doctor`/`urls`/`keys` and 8 steps, not 6).
- **Webhook/IdP-metadata SSRF is hostname-level only** (DNS-rebinding gap) — a public host resolving to a private IP at fetch time passes create-time and dispatch-time checks. Documented as known; resolve-then-validate the IP is the highest-value SSRF hardening left.

---

## LOW (polish tail)

- `user.list` / `user/key.ts:list` advertise an `orderBy` arg the handler never reads (`user.ts:113-149`) — broken contract; wire it (as `group.ts:list` does) or drop it.
- Four unused indexes on `UserEmail` (`schema.ts:90-94`) — write-amplification; drop the ones with no consumer or land the connection-scoped linking path they seem reserved for.
- `vAuthEventProjectionDoc` advertises an `ip` field public reads always return `undefined` (`model.ts:825`) — remove from the public validator.
- `vUserPatchData` is a verbatim copy of `vUserInsertData` (`user.ts:19-43`) — derive both via `partial(pick(schema.tables.User.validator.fields,…))`.
- `session.create` replaced-session token delete is unbounded (`session.ts:62-69`) — bound with `.take(SESSION_TOKEN_DELETE_BATCH)` like `token/refresh.ts`.
- Inline narration comments (LEXICON: JSDoc-only) at `oauth/refresh.ts:175-176,207-212` and `oauth/token.ts:192-193` — load-bearing security notes; promote into JSDoc `@remarks` rather than delete.
- **LEXICON self-contradiction:** §4a points to `shared/error-codes.ts` (does not exist; the file is `shared/codes.ts`) and documents a `defineAuth({ oauth: { scopes } })` shape that doesn't typecheck (`ConvexAuthConfig.oauth` has no `scopes`). Found by two independent auditors.
- Token-endpoint RFC polish — `oauth/token.ts:60` error responses omit `Cache-Control: no-store`; seven 401s omit `WWW-Authenticate`.
- `templates.ts:20-52` escapes `host` but interpolates `url` raw — not live XSS (library-built magic link) but an unsafe-by-construction sink; escape every interpolation.
- `services/*Live` client layer (`client/services/*`, ~43 lines) is Effect-style naming over four identity functions with no Effect runtime — delete.
- `FactorDeps`/`TotpDeps`/`DeviceDeps` are the same ~20-line type declared three times (`client/core/types.ts:97`, `factors/totp.ts:17`, `factors/device.ts:20`) — one exported type.
- Dead cron-poll webhook delivery path (`webhook/delivery.ts:153-168`, `webhook.ts:155-195`) with a divergent second backoff calc — no callers; delete.
- `redirect.ts` is a 6-line `@internal` helper, not the escape hatch it's sometimes described as (the real one is `custom.ts`, which is well-designed) — no action, just noting.
- Expo silently lacks `runtime.sync`/`runtime.mutex` (cross-tab sync + cross-context lock) that browser provides — arguably fine on single-process RN, but the parity gap is invisible at the type level; document it.
- `.npmignore` duplicates `files[]` negative globs; `dist/model.*`/`dist/schema.*` ship unreferenced; `tsconfig.consumer.json` maps `/errors` to a subpath not in `exports`; reference-app `convex/functions.ts:4` imports the heavy `auth` handle instead of `./auth/core`; `reference/architecture` calls `auth.oauth.*` "not shipped yet" while it ships; several env vars (`AUTH_LOG_SECRETS`, `AUTH_PASSWORD_EMAIL_VERIFICATION`, `AUTH_EMAIL`, `RESEND_API_KEY`) are undocumented; `credentials()` provider has no docs page. **[Low-confidence]** `bench.ts` appears orphaned (no CI/package reference) — confirm before deleting.

---

## Test coverage matrix (offline)

| Feature                                                                                           | Coverage                                                                                 |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Sessions, Password auth, OAuth IdP, OAuth refresh/theft, OAuth scope, RFC 7591/7592 DCR, API keys | **STRONG**                                                                               |
| Invites, Audit events, Well-known/discovery, MCP, Groups/roles, OIDC connections                  | PARTIAL                                                                                  |
| **SAML connections**                                                                              | **LOW — interop-only (Docker happy-path); no offline reject/decrypt/SLO/metadata-parse** |
| **SCIM provisioning**                                                                             | **LOW — config/validate only; no provisioning-cycle/reconciliation test**                |
| **Connection webhooks**                                                                           | **LOW — no delivery/retry/dispatch test**                                                |
| **Passkeys / WebAuthn**                                                                           | **ZERO offline**                                                                         |
| **TOTP / MFA**                                                                                    | **ZERO offline**                                                                         |
| **Provider config (github/google/apple/microsoft/custom/password)**                               | **ZERO**                                                                                 |
| **Client adapters — React / Svelte / Expo / Browser**                                             | **ZERO**                                                                                 |
| **CLI (setup/doctor/urls/keys)**                                                                  | **ZERO behavioral**                                                                      |

Test-project convention (undocumented — an onboarding footgun): `*.node.test.ts` → `node` vitest project (crypto/JWT/`jose`); `*.test.ts` → `convex` in-memory project; `interop` → Docker backend for SAML. Routing is by include-globs in `vite.config.ts`; a mis-suffixed file silently runs in the wrong runtime.

---

## What's good (calibration)

- **Validator discipline** — ~100% return-validator coverage; flat object args; `consumer/types.ts` is an _above-bar_ compile-time contract asserting removals and rejections via deliberate `@ts-expect-error`.
- **LEXICON verb discipline** — near-perfect: overloaded `get`, `remove` const-export, ownership-nesting, sanctioned domain verbs.
- **Layering** — verified zero upward imports from deep modules into the composition root.
- **Event-sourcing** — append + projection are atomic per mutation; intra-file `Record<AuthEventKind,…>` exhaustiveness is compiler-enforced; single-writer drain is idempotent.
- **Crypto** — constant-time compares at every secret comparison; hash-only token lookups; AES-GCM secret box; disciplined log redaction (`maybeRedact`).
- **OAuth IdP / refresh / OIDC-RP** — the strongest code in the repo: grant-root revocation, fail-closed lookups, PKCE-S256-only, nonce/issuer/audience/azp checks, userinfo↔id_token subject cross-check, `oauth/grant.ts` one-predicate-three-boundaries, `mcp.ts` clean RFC 9728.
- **SAML XSW/crypto defenses (the parts that exist)** — DOCTYPE/ENTITY rejection through one hardened parser; extraction over cryptographically-verified canonical bytes (neutralizes the comment-truncation CVE class); decrypt accepts only AES-GCM + RSA-OAEP.
- **Exports map** — all 16 subpaths resolve to real dist; `attw`/`publint` in `prepublishOnly`; CLI secret hygiene (temp-file + `--from-file` + `hideValue`) is careful.
- **`server/component/api.ts`** — `AuthComponentApi = ComponentApi<"auth">` is the exemplar the boundary refactor (H11) should standardize on; **`cache/context.ts`** is a correct request-scoped read-dedup, not a denormalized cache; **`domains/member.ts`** `capGrantsForCaller` is exemplary single-source-of-truth.

---

## Recommended sequencing

1. **Security cluster first (C1, H1–H5, H8).** Small, surgical, and they share the theme A root — wire existing proofs/primitives into enforcement. Start with C1 (replay store) and H1 (`verifiedAt` gate) as they're the exploitable ones; H8 (audit events) is nearly free.
2. **Bounded-growth (C2, H6, H7).** Add webhook-delivery pruning; bound the re-parent cascade; demote+reschedule `pruneExpired`. All S.
3. **Then the maintainability themes (H10–H13, H15) + docs (H14) + the MEDIUM type/error/CORS consolidations.** These pay down the drift that will otherwise keep generating findings; H11 (one component boundary) is the highest-leverage L.
4. **Test coverage (H16) in parallel** — the SAML seam work (injectable clock + typed errors) unlocks the highest-value offline tests and de-risks the security fixes above.

---

## Runtime behavior — chattiness, logging, durability

A second focused pass (3 auditors: client chattiness/durability, server call-amplification/logging, server session-state durability & races) hunting runtime behavior rather than architecture. Every HIGH below was re-verified at file:line by the orchestrator. The unifying insight: **everything inside a single `auth:store` mutation is atomic and OCC-safe by construction; the defects are in the two flows orchestrated in an _action_ (client boot, device flow), where consume-and-effect land in separate transactions.**

### R1 — [HIGH] Browser cold-boot sends two identical `authenticate` round-trips

`client/index.ts:1196` (constructor `bindConvexAuth()` on the sync-read seed token) then `hydrateFromStorage` (`:1100-1107`) reads the _same_ token and calls `setToken` with `resyncConvexAuth: true`, re-firing `bindConvexAuth()` (`:656-658`) → a second, redundant `authenticate`. Each bind pauses/resumes the Convex socket, so boot stalls all queries twice. Browser-only (Expo's async SecureStore leaves the seed null → one bind). **Fix:** hydrate passes `resyncConvexAuth: false` when the hydrated token equals the already-bound one.

### R2 — [HIGH] Auth-context resolution makes 2 redundant component RPCs on every authenticated request

`server/context.ts:90-98` (`getAuthContextForUser`) uses only `activeGroup.groupId` but calls `active.get` (`core.ts:245-256`), which runs a `member.list` reading up to **100 rows** + a `group.get` to build fields that are discarded, then `member.get` re-derives membership+grants anyway — 4 RPCs where 2 suffice, on the hottest path (every `auth.ctx()` + every HTTP auth branch). **Fix:** read `User.lastActiveGroup` (already on the step-1 user doc) locally and feed it to `member.get`; bounded fallback only when unset/stale.

### R3 — [HIGH] Device `verify` and `poll` are non-idempotent → duplicate / orphaned sessions

`server/device.ts` — `handlePoll`/`handleDeviceVerify` run in an **action** (`EnrichedActionCtx`, `:26`), so consume and sign-in are separate transactions. Verify (`:155-174`): `callSignIn` (T2) then `mutateDeviceAuthorize` (T3) — die/retry between and the still-`pending` code re-signs-in → second session, first orphaned for its full TTL; `authorize` (`component/factor/device.ts:74-79`) is an unconditional patch with no `pending→authorized` precondition. Poll (`:97-135`): reads `doc` (T1), deletes (T3, idempotent no-op) then `callSignIn` (T4) — two polls observing `authorized` both mint a session. **Fix:** consume atomically in one component mutation — a `pending→authorized` (verify) / `authorized→consumed`+delete (poll) compare-and-set that returns whether it won; mint the session only on the win.

### R4 — [MEDIUM] Password sign-in accumulates sessions

`server/mutations/credentials/signin.ts:167-171` issues a session with no `replaceSessionId`, unlike `signInSessionImpl`/`verifyCodeAndSignInImpl` which pass the caller's current session. Re-issuing on an already-authenticated context (or a retried action) stacks independent session+refresh chains. Asymmetry reads as an oversight. **Fix:** thread `getAuthSessionId(ctx)` if dedup is intended.

### R5 — [LOW] `log()` serializes args before the level gate

`server/shared/log.ts:40-77` runs `args.map(serialize)` (JSON.stringify) + allocates the handler map before checking level, so gated DEBUG calls "pay then drop." Bounded to sign-in/OAuth/store mutations, not the read path. **Fix:** early-return below configured level before serializing.

### R6 — [LOW] Client device-flow poll cannot be cancelled

`client/factors/device.ts:63-127` — rate-safe loop but takes no `AbortSignal`; on UI unmount it keeps hitting the server every interval until expiry (≤30 min). **Fix:** accept + check an `AbortSignal`.

### Verified sound (do not re-investigate)

Durable/OCC-safe by construction: **session refresh** and **OAuth refresh** exchanges (concurrent exchanges conflict; retry takes the active-child branch — no double-rotation), **OAuth code / verification-code / PKCE-verifier consumption** (atomic delete-or-fail), **event append + `drainPending`** (unique-index dedup, self-reschedules only while work remains, crashed drain re-runs without dropping), `pruneExpired`, the in-transaction rate limiter. Client: no refresh-timer storm (Convex drives refresh; `navigator.locks` mutex coalesces N tabs), `getSnapshot` referentially stable (no re-render loops), spans no-op when tracing off, JWKS/keys process-cached, token persistence write-through. Logging is level-gated with nothing per-request/per-read.

---

## MCP clients lose access multiple times a day (root-cause diagnosis)

Symptom: MCP OAuth clients intermittently lose access and must fully re-authorize, several times a day. Traced end-to-end; the primary cause is verified at file:line.

### M1 — [HIGH, primary] 15-min access token + a refresh exchange that isn't retry-idempotent + whole-grant revocation

Three settings compound:

- **Access token TTL = 15 min** (`OAUTH_ACCESS_TOKEN_DURATION_S = 900`, tokens.ts:87; returned as `expires_in` from code + refresh exchanges). A long-lived MCP session refreshes ~40–96×/day.
- **Refresh reuse window = 10 s** (`REUSE_WINDOW_MS = 10_000`, server/oauth/refresh.ts) and a **reuse _outside_ the window revokes the entire `OAuthRefreshGrant`** (`revokeGrant` → `revokedAt`, component/oauth/refresh.ts:213-236) → every token in the chain fails closed → the client's next refresh gets `invalid_grant` (oauth/token.ts:282-283) → **full re-authorization**.
- **In-window replay is non-idempotent.** Because refresh tokens are hash-only the server can't re-hand the active tip like the session path does (`component/token/refresh.ts:210-220` returns the already-issued active child); instead it **deletes the sibling tip and mints a fresh child** (refresh.ts:202-232, comment at :207). So a retried/concurrent refresh can leave the client holding a token the server just deleted.

Triggers (both normal client behavior): (a) a **retry >10 s after a slow/dropped token response** (routine on Convex HTTP-action cold starts, or client backoff / device sleep) replays the old token outside the window → whole grant revoked → re-auth; (b) **concurrent/pipelined refresh** → last-writer-wins supersede deletes the sibling the client may have persisted → next refresh `invalid` → re-auth. At ~40–96 refreshes/day, a low per-refresh mishap rate → multiple re-auths/day.

**Fix (tiered):**

- _Low-risk, kills the deterministic failure:_ widen the reuse window (10 s → 60 s+, configurable); in the just-outside-window fall-through (refresh.ts:235) reject only the single token (`invalid`) instead of `revokeGrant`, reserving whole-grant revocation for the unambiguous theft signal (tip advanced strictly past a consumed token, :220-226); add `clockTolerance: 30` to `jwtVerify` (tokens.ts:169-172).
- _Robustness (needs a storage decision):_ make in-window replay idempotent — keep the sibling tip valid (don't delete) so whichever child the client kept still works, or re-hand the active tip (requires storing recoverable child material for the window, which trades against hash-only storage).
- _Frequency:_ raise `OAUTH_ACCESS_TOKEN_DURATION_S` toward 1 h (matches the session `DEFAULT_JWT_DURATION_MS`) to cut refresh cadence ~4×.

### M2 — [check deployment] RFC 8707 `resource` exact-match → total 401 (not the intermittent symptom, but rule out)

The MCP endpoint requires the token's `resource` claim to **exactly equal** `canonicalResource()` = `CONVEX_SITE_URL` (trailing-slash-stripped) + `mcpPath` (runtime.ts:714; enforced `resource !== opts.resource` at tokens.ts:180). The claim is bound from whatever the **app-owned consent page** forwards to `oauth.code.authorize`. If the consent page drops `resource`, the client omits RFC 8707 `resource`, or `CONVEX_SITE_URL`/`mcpPath` normalization skews (slash/casing/port), the token 401s. This is deterministic (always fails or always works), so it's not the _intermittent_ symptom — but verify the consent page forwards `resource` and the canonical strings match.

### M3 — [LOW] No clock-skew tolerance on a short token

`jwtVerify` has no `clockTolerance` (tokens.ts:169-172, defaults 0s); on a 15-min token a resource-server clock slightly ahead rejects tokens in their final seconds, adding spurious 401s that push the client into the fragile refresh path more often. Fix folded into M1.

### Ruled out (with evidence)

DCR _does_ issue refresh tokens (`DCR_GRANT_TYPES` includes `refresh_token`, register.ts:6; issued at token.ts:217); discovery advertises `refresh_token` + endpoints (http.ts:731-742); `capGrantsForCaller` never invalidates a live token mid-life (member.ts:53-62, not in the MCP scope gate); no cron reaps live grants (`pruneExpired`/`purgeRevokedGrant` key on `expiresAt < now` (30-day) or already-`revokedAt`, and the grant's `expiresAt` advances with its child, refresh.ts:191-193); OAuth reuse revokes the _grant_, not the login _session_.
