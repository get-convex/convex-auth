# LEXICON — `@robelest/convex-auth` API conventions

This file is the authoritative naming and shape contract for everything
exposed by the auth component (`packages/auth/src/component/**`) and the
server facade (`packages/auth/src/server/**`).

Read this before adding a new public function, validator, or file path.
The lexicon mirrors Convex's own idioms; deviating from it requires a
written justification in the PR description.

## 0. Setup surface and vocabulary

The vNext setup surface is definition-first:

```ts
export const permissions = definePermissions({
  grants: ["members.read", "connection.manage"],
  roles: {
    admin: {
      label: "Admin",
      grants: ["members.read", "connection.manage"],
    },
  },
});

export const auth = defineAuth(components.auth, {
  providers: [password(), google()],
  permissions,
});
```

- `defineAuth` is the only canonical app auth definition. Do not introduce a
  second setup factory in vNext public docs or exports.
- Prefer `definePermissions` and the config key `permissions`. Do not introduce
  new public docs or APIs around `authorization: { roles }`.
- `grants` are the atomic permissions code checks. `roles` are named bundles of
  grants assigned to memberships and invites.
- Group connection (SSO) admin is the flat `auth.connection.*` facade; expose it
  with your own `authMutation`/`authQuery` that authorize via `auth.member.assert`.
  Do not export or document a `mount` factory.

---

## 1. Function verbs

| Verb     | Use for                                                                                                      | Don't use these synonyms |
| -------- | ------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `get`    | Read by identity or selector (overloaded object args allowed: `id`, `ids`).                                  | `fetch`, `read`, `find`  |
| `list`   | Paginated or bounded list of documents.                                                                      | `index`, `query`, `all`  |
| `create` | Insert a new document.                                                                                       | `insert`, `add`, `make`  |
| `update` | Partial patch of an existing document. Patch payload arg is `patch` (matches `ctx.db.patch`).                | `modify`                 |
| `upsert` | Insert-or-update with idempotency.                                                                           | `save`, `set`            |
| `remove` | Hard-delete a document. Chosen over `delete` (reserved word → `{ delete_ as delete }`) and crud's `destroy`. | `delete`, `destroy`      |

**Domain verbs** are allowed when the workflow is more than CRUD. The two
auth-defining verbs are kept strictly distinct:

- **`authorize`** = _permit access_ — a user (or provider) grants a client or
  device the ability to act. Used for device-flow approval, OAuth client
  approval (`auth.oauth.authorize`), and the provider sign-in callback
  (`credentials` / `password` / `phone`.`authorize`).
- **`verify`** = _prove a fact_ — validate a presented secret or assertion.
  Used for TOTP, passkeys, email/phone codes, domain ownership, and
  API-key / client-secret checks. **TOTP is `verify`, never `authorize`.**

Other domain verbs: `exchange` (token→token, e.g. refresh rotation / OAuth
code→token), `accept` (consume a one-time token — invites, OAuth codes),
`revoke` (soft-delete / invalidate, incl. signing out a user's sessions),
`assert` (assert the caller holds grants, throws), `dispatch` (webhook
delivery), `provision` (atomically materialize an externally managed identity),
`promote` (raise one item in a set to a privileged role, e.g.
`user.email.promote` making a verified address primary). Add to this list when
introduced. **Not verbs** (cut from the
lexicon — use the canonical above): `issue`→`create`, `archive`→`revoke`,
`consume`→`accept`, `redeem`→`accept`.

`grant` / `grants` is a NOUN reserved for atomic permissions
(`definePermissions`, `member` grant checks) — never an OAuth verb. An OAuth
client's allowed protocol flows are `grantTypes`; the RFC wire param
`grant_type` is external protocol, not part of this lexicon.

**Adoption status — fully applied across the codebase** (component + facade +
app + tests + docs), as hard cuts (no aliases/back-compat):

- `authorize` / `grantTypes` (OAuth).
- `delete`→`remove`; `require`→`assert`; `update` patch arg `data`→`patch`.
- `user.email.add`→`create`; `session.issue`→`create` (the dead simple
  `session.create` was dropped).
- `connection.domain.add`→`create`; `user.email.primary.set`→`user.email.promote`
  (the `email.primary` namespace keeps only `get`); `user.email.create`/`remove`
  positional `email` → object arg `{ email, userId? }`.
- Component: `group.invite.redeem`→folded into overloaded `group.invite.accept`
  (`{ id }` admin-accept | `{ tokenHash }` accept-by-token + membership);
  `connection.cache.fetchJson`/`fetchText`→`requestJson`/`requestText` (`fetch`
  is banned); `user.email.owner` removed (was dead — its only consumer
  `db.emails.findVerified` had no callers).
- **Lexicon cut-down (this pass):** `session.archive`→`session.revoke`;
  `oauth.client.archive`→`revoke` (+ doc field `isArchived`→`revoked`, event
  `oauth.client.archived`→`revoked`, indexes); `oauth.code.consume`→`accept`;
  `oauth.refresh.issue`→`create`. `archive`/`consume`/`issue` no longer appear.
- `member.inspect`→`get` (the by-id facade `get` was dropped; `get` now resolves
  a member's effective grants by `{ userId, groupId }`).
- `metadata`→`extend` for the app-extension blob (ApiKey / OAuthClient). The
  `@convex-dev/stream` event-stream `metadata` field is unrelated and untouched.
- Audit-event `scope`→`target` (`targetKind`/`targetId`, `authEvents.target.*`,
  the `target` where-builder field, and the `target_*` / `by_target` /
  `event_id_target` indexes), removing the overload with the capability
  `scope`/`scopes` (OAuth / API key), which stay as-is.

`create` keeps the arg name `data` (the new-document payload); only `update`
uses `patch`. `exchange` (refresh-token rotation) and `accept` (invite + OAuth
code acceptance — the facade unifies the paths under `accept`) remain as
distinct domain verbs.

User profile names use `name` for the formatted/display name and the explicit
`firstName` / `lastName` fields for structured given/family names. Connection
profile mappings (including SCIM) preserve all three through the User schema;
they must not write undeclared keys or hide canonical profile fields in
`extend`.

**Read overloading:** prefer one overloaded `get` over multiple
`getByX` functions. Accept all selectors as optional object fields and dispatch
inside the handler. Component calls look like `ctx.runQuery(component.user.get,
{ id })`; server facade calls mirror that shape: `auth.user.get(ctx, { id })`,
`auth.user.get(ctx, { ids })`, `auth.user.get(ctx, { verifiedEmail })`.

---

## 2. Argument shapes

| Arg                    | Shape                                                                      |
| ---------------------- | -------------------------------------------------------------------------- |
| Primary identity       | `id: v.id("Table")` — bare `id`, no entity prefix.                         |
| Batch identity         | `ids: v.array(v.id("Table"))` — returns ordered, deduped results.          |
| Foreign key            | `<entity>Id: v.id("Entity")` — e.g. `userId`, `connectionId`, `accountId`. |
| Pagination input       | `paginationOpts: paginationOptsValidator` (from `convex/server`).          |
| List filter envelope   | `where: v.optional(v.object({ … }))` — every filter field optional.        |
| Sorting                | `orderBy` (literal union of field names) + `order` (`"asc"` \| `"desc"`).  |
| Mutation patch payload | `data: v.object({ … })` — every field optional for partial update.         |

Don't accept positional args in public APIs (always use object args after `ctx`).
Don't use `args.opts` / `args.input` envelopes — flat args only.

---

## 3. Return shapes

- **Single read**: `vXxxDoc | null` (or unioned shapes when overloaded).
- **Paginated list**: `vPaginated(vXxxDoc)` → `{ page, isDone, continueCursor }`. Never invent a custom `{ items, nextCursor }` shape.
- **Bounded list** (per-user, per-session — small fixed set): `v.array(vXxxDoc)`. Document in JSDoc that the set is bounded so future readers don't expect pagination.
- **Mutation**: `v.id("Table")` for component inserts, `v.null()` for component
  updates/deletes. Server facade methods may return small command summaries
  (for example `{ id }`, `{ keyId, secret }`) when that is the public ergonomic
  shape, but their input remains Convex-native object args.

---

## 4. Validators

- Document validators: `vXxxDoc` (e.g. `vUserDoc`, `vAccountDoc`).
- Enum unions: `vXxxStatus`, `vXxxType`, `vXxxKind`.
- Helper unions/objects: `vXxxScope`, `vPaginated(X)`.
- All validators are `v`-prefixed PascalCase. **No** suffix-`Validator` style.
- Only export a validator if used outside the file it's defined in. Compound parts of larger validators stay file-local `const`.

## 4a. Error codes

- Throw `new ConvexError({ code: ErrorCode.X, message, ... })` — import `ErrorCode` from `packages/auth/src/shared/codes.ts`.
- **Never** inline a string literal in `code:`. The central registry is the source of truth; typos surface at compile time, and the union type lets consumers exhaustively switch.
- New codes go in `shared/codes.ts` first, then are used at the throw site.

---

## 5. File paths inside `component/`

- **One file per public namespace.** A file at `component/<path>.ts` is the public surface for `component.auth.<path>`.
- **Singular nouns.** `user.ts`, not `users.ts`. `factor/device.ts`, not `factor/devices.ts`.
- **Nest sub-resources** under the parent entity: `group/member.ts`, `group/invite.ts`, `connection/domain.ts`, `connection/scim/config.ts`, `user/email.ts`, `user/key.ts`, `token/refresh.ts`, `token/pkce.ts`, `token/verification.ts`.
- **No `public/` folder.** Function bodies live at their namespace path, not in a sibling shim tree.
- **Internal helpers stay in the same file** until they grow > 1 screen (~80 lines). Then split into a sibling `*-helpers.ts` (no namespace impact since helpers don't export Convex functions).

---

## 6. Function visibility (`query` vs `internalQuery`)

- **`query` / `mutation`** — anything reachable from the parent app's `convex/` via a typed `components.auth.X.Y` reference (`LooseComponentRefs<ComponentApi<"auth">>` strips internal functions from this surface).
- **`internalQuery` / `internalMutation`** — only callable from _inside_ the same component (via `internal.X.Y`). Use sparingly; the moment a server facade wants to call something via `componentSso.X.Y`, it has to be `query`/`mutation`.

The cross-component typed ref is the constraint. Don't demote a function to `internalQuery` just because it returns a bare array — return shape is independent of visibility.

---

## 7. Pagination discipline

- **Unbounded UI list** (audit events, webhook deliveries, SCIM identities): `paginationOptsValidator` + `vPaginated(X)`. **Inside the component, the built-in `ctx.db…paginate()` is NOT supported** (it throws `paginate() is only supported in the app`). Use convex-helpers instead: `paginator(ctx.db, schema).query(...)…paginate(opts)` for index-only queries, or `stream(ctx.db, schema).query(...).order(...).filterWith(async (d) => …).paginate(opts)` when you need post-index filtering (`paginator` does not support `.filter()`). Never call `ctx.db.query(...).paginate()` in a component function.
- **Bounded set helper** (per-user sessions/accounts/passkeys/totps/emails/refresh tokens; per-connection domains/endpoints): `.collect()` returning `v.array(X)`. Allowed because the set is naturally small.
- **Worker queue scan** (e.g. `connection.webhook.delivery.dueForDispatch({ now, limit })`): `.take(limit)` returning `v.array(X)`. Allowed because workers cap per-tick batch size externally.
- **Never** invent custom `{ items, nextCursor }` shapes. **Never** do `.collect()` + JS slice as a pagination workaround — fix the schema or accept a bounded list.

---

## 8. Component API handle (advanced)

The auth runtime passes the component API around as a config field, aliased as `AuthComponentApi` (`packages/auth/src/server/component/api.ts`) — the full generated `ComponentApi<"auth">` with args/returns intact. Domain code stays decoupled from the concrete refs via the loose `runQuery`/`runMutation` casts centralized in `componentQuery`/`componentMutation` (`server/contract.ts`), not via a type that erases `Args`/`Returns`. **Do not** introduce parallel handle types or alias chains; reuse `AuthComponentApi`.

---

## 8a. OAuth authorization server (app-as-IdP)

When `defineAuth({ oauth: { pages: { login, consent } } })` is set, the app
acts as an OAuth 2.1 authorization server (e.g. for MCP clients). Presence of the
`oauth` block enables the AS; the library owns all wire endpoints, CORS, and discovery.

- **Wire endpoints** (external protocol, fixed names, discoverable via AS metadata):
  `GET {prefix}/oauth2/authorize`, `POST {prefix}/oauth2/token`, `POST {prefix}/oauth2/register`
  (RFC 7591 DCR) + RFC 7592 `GET/PUT/DELETE {prefix}/oauth2/register/{clientId}` (authenticated by
  the one-time `registration_access_token` issued at registration). The token
  form param `grant_type` (`authorization_code` | `refresh_token` | `client_credentials`) is
  RFC wire, not lexicon.
- **MCP** is an OAuth-protected resource server registered via
  `auth.request.mcp(http, tools, opts?)` (tools are plain `{ description, scope, args, handler }`
  objects; `args` inferred per tool). It mounts `POST /mcp`, the bearer challenge, and
  `/.well-known/oauth-protected-resource`. See §8a-mcp.
- **Server surface:** `auth.oauth.client.{create,get,list,revoke,verify,update,verifyRegistrationToken}`
  (the OAuth client registry; `update`/`verifyRegistrationToken` back RFC 7592 management, `create`
  also returns the one-time `registrationAccessToken` and, for confidential clients, the secret), `auth.oauth.code.{authorize,accept}` (`authorize` records a user's approval and
  mints a single-use code — the consent page calls this; `userId` MUST be the authenticated
  caller, never request input; `accept` consumes it at the token endpoint), and
  `auth.oauth.refresh.{create,exchange,revoke}` (rotating refresh tokens; `exchange` is the
  refresh-rotation verb per §1, and emits `oauth.refresh.reuse_detected` when a replayed token
  trips theft detection; `revoke` emits `oauth.refresh.revoked`). `auth.oauth.authorize(ctx, args)` is the documented alias of
  `code.authorize`. The shared client-grant predicate (`checkOAuthGrant`, `oauth/grant.ts`) is
  the single source of truth used by the authorize handler, the `code.authorize` mutation, and
  the token endpoint — each formats denials for its own boundary.
- **Component surface:** `component.oauth.client.*`, `component.oauth.code.*`, and
  `component.oauth.refresh.*`. The client doc's allowed flows are `grantTypes` (not `grants`);
  its `tokenEndpointAuthMethod` is `client_secret_post` | `client_secret_basic` | `none`
  (public, PKCE-only, no secret). `code.accept` enforces the `clientId` binding in-transaction.
- **Access tokens** are signed `at+jwt` JWTs. `aud` is `"convex"` (string) — keeps them valid
  Convex identities. RFC 8707 resource binding lives in a separate `resource` claim (default
  `<origin>/mcp`), validated at `/mcp` via `verifyOAuthToken({resource})`; the `aud: ["convex",
<resource>]` array form is a documented follow-up gated on Convex accepting an array audience.
  `sub` = the user id (or `client:<id>` for `client_credentials`), plus `client_id` and (when
  bound) `resource` claims. `auth.request.context`
  classifies them as `source: "oauth"`.

---

## 9. Drift policy

If a PR diverges from this lexicon, the PR description must (a) name the
specific section being violated and (b) justify why. If the divergence
is intentional, update this file as part of the PR so the lexicon stays
the source of truth.
