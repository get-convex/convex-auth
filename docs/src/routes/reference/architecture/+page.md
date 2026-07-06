---
title: Architecture
description: How convex-auth works as a Convex component.
---

<script>
  import Card from '$lib/components/docs/Card.svelte';
  import CardGrid from '$lib/components/docs/CardGrid.svelte';
</script>

<svelte:head>

  <title>Architecture - convex-auth</title>
</svelte:head>

# Architecture

## Component model

Your app registers the auth component and wires four files:

<CardGrid>
  <Card title="convex.config.ts">
    <code>defineApp({'{'} env: authEnv {'}'})</code> and
    <code>app.use(auth)</code> — registers typed env, the auth component, and
    isolated storage/functions.
  </Card>
  <Card title="auth.ts">
    <code>defineAuth(components.auth, {'{'} providers, permissions {'}'})</code> — vNext preview setup for providers,
    permissions, helper namespaces, and HTTP routes.
  </Card>
  <Card title="auth/core.ts">
    Lightweight context import for queries and mutations. No providers or crypto
    loaded.
  </Card>
  <Card title="HTTP alias">
    <code>auth.http()</code> — mounts OAuth callbacks,
    JWKS, and SSO protocol routes from the app-side alias.
  </Card>
</CardGrid>

The component owns its own isolated tables:

| Table              | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `User`             | User records                                 |
| `Account`          | Linked auth accounts (OAuth, password, etc.) |
| `Session`          | Active sessions                              |
| `Group`            | Organizations / teams                        |
| `Member`           | Group memberships with role ids              |
| `Invite`           | Pending invitations                          |
| `ApiKey`           | API keys with scopes                         |
| `Passkey`          | WebAuthn credentials                         |
| `Totp`             | TOTP enrollments                             |
| `Group Connection` | SSO connections (OIDC/SAML/SCIM config)      |

The auth component also installs three Convex subcomponents internally:

| Subcomponent               | Role                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| `@convex-dev/migrations`   | Versioned data migrations against the component's own tables       |
| `@convex-dev/rate-limiter` | Sign-in throttle (token-bucket; backs `auth.signIn` rate limiting) |
| `@convex-dev/workpool`     | Webhook delivery worker — drives retries with exponential backoff  |

These are mounted by `component.use(...)` inside `convex.config.ts`; the
parent app doesn't install or configure them.

## Function visibility

Component functions are private to the component boundary from the browser's
point of view. The parent app reaches the component through typed component
references and server-side wrappers, usually the `auth.*` helpers documented
under API Reference. Client-callable Convex functions still live in the parent
app, where you choose what to export.

## Scheduled cleanup

The component owns its own `crons.ts` and runs a daily `pruneExpired`
job (03:00 UTC) that prunes expired rows from `Session`, `RefreshToken`,
`VerificationCode`, `AuthVerifier`, `GroupInvite`, and `DeviceCode`.
Batched at 200 docs per run by default; rerun the cron tomorrow to drain
any backlog.

## Auth flow

1. **Client** calls `signIn(provider, params)`
2. **App** stores a verification code in the component and returns a redirect
   URL
3. **Client** redirects to the OAuth / SSO provider
4. **Provider** authenticates the user and redirects back with a code
5. **App** calls the component to verify the code and upsert the user
6. **Component** returns session tokens (JWT + refresh token)
7. **Client** stores tokens — subsequent requests include the JWT

For subsequent requests:

- Queries/mutations call `ctx.auth.getUserIdentity()` which returns
  `{ subject: "userId", sid: "sessionId", email?, name?, picture? }`
- `auth.ctx()` / `auth.context(ctx)` resolves
  `{ userId, user, groupId, role, grants }`

## Key design constraints

- Component functions are not browser-callable through the parent app unless
  your app exports wrappers. Your app chooses the public auth actions and SSO
  admin RPC it wants to expose.
- Components cannot access `ctx.auth` or `process.env`. Auth checks and env var
  reads happen at the app layer. In Convex 1.41+, prefer typed env with
  `defineApp({ env: authEnv })` and generated `env` imports.
- Component tables are isolated — they don't share the app's data model.

## What `defineAuth` returns

`defineAuth(components.auth, config)` is the vNext preview replacement for the
old `defineAuth(...)` mental model. It returns one auth handle with:

- **Actions**: `signIn`, `signOut` — the client-facing auth flow
- **Internal runtime**: `store` — session token exchange used internally by the auth runtime
- **Helpers**: `auth.user.*`, `auth.session.*`, `auth.group.*`, etc. —
  server-side primitives
- **Request helpers**: `auth.request.context`, `auth.request.action`, and `auth.request.route` for your own app routes
- **Connection (SSO)** (conditional): `auth.connection.*` — only present when
  `connection()` is in providers. Expose admin RPC by writing your own
  `authMutation`/`authQuery` functions that call this facade.

## Entry point split: `server` vs `core`

The full auth definition from `@robelest/convex-auth/server` loads provider
implementations, OAuth, crypto, and HTTP route handling. Queries and mutations
should not load that code unless they need it. To keep function bundles fast,
use the split pattern:

```ts
// convex/permissions.ts — pure shared permission definition
import { definePermissions } from "@robelest/convex-auth/permissions";

export const permissions = definePermissions({
  grants: ["members.read"],
  roles: {
    member: {
      label: "Member",
      grants: ["members.read"],
    },
  },
});
```

```ts
// convex/auth.ts — heavyweight, only evaluated for signIn/signOut
import { defineAuth } from "@robelest/convex-auth/server";
import { google, password } from "@robelest/convex-auth/providers";
import { permissions } from "./permissions";

export const auth = defineAuth(components.auth, {
  providers: [google({ clientId, clientSecret }), password()],
  permissions,
});

export const { signIn, signOut, store } = auth;
```

```ts
// convex/auth.config.ts — native Convex JWT trust
import { env } from "./_generated/server";

export default {
  providers: [
    {
      domain: `${env.CONVEX_SITE_URL}/auth`,
      applicationID: "convex",
    },
  ],
};
```

```ts
// convex/auth/core.ts — lightweight, imported by all queries
import { createAuthContext } from "@robelest/convex-auth/core";
import { components } from "../_generated/api";
import { permissions } from "../permissions";

export const auth = createAuthContext(components.auth, {
  permissions,
});
```

```ts
// convex/functions.ts
import { customQuery, customMutation } from "convex-helpers/server/customFunctions";
import { query, mutation } from "./_generated/server";
import { auth } from "./auth/core";

export const authQuery = customQuery(query, auth.ctx());
export const authMutation = customMutation(mutation, auth.ctx());
```

`createAuthContext` is the current lightweight context entry point. In vNext
docs, keep its vocabulary aligned with `defineAuth`: pass `permissions`, use
object args, and keep provider, OAuth, and crypto code out of query/mutation
bundles.

| Entry point                         | What it loads                               | Use for                                         |
| ----------------------------------- | ------------------------------------------- | ----------------------------------------------- |
| `@robelest/convex-auth/server`      | Everything (providers, OAuth, crypto, HTTP) | `convex/auth.ts` — signIn/signOut exports       |
| `@robelest/convex-auth/core`        | Context resolution only (~2KB)              | `convex/functions.ts` — query/mutation wrappers |
| `@robelest/convex-auth/browser`     | Browser client defaults                     | Web apps and SSR client hydration               |
| `@robelest/convex-auth/react`       | React gates + app-owned auth client context | React apps wrapping the browser client          |
| `@robelest/convex-auth/svelte`      | Svelte runes bridge + gate components       | Svelte 5 apps wrapping the browser client       |
| `@robelest/convex-auth/expo`        | Expo SecureStore, AuthSession, passkeys     | Expo / React Native apps                        |
| `@robelest/convex-auth/providers/*` | Individual provider                         | Only in `convex/auth.ts`                        |

Your app also needs `convex/auth.config.ts` so Convex trusts the JWT issuer
used by Convex Auth.

## Where `ctx.auth` comes from

Neither `defineAuth` nor `createAuthContext` mutate every Convex handler
automatically. App code wires `auth.ctx()` into custom builders once, then uses
those builders everywhere auth is required.

```ts
// convex/functions.ts
import { customAction, customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { action, mutation, query } from "./_generated/server";
import { auth } from "./auth/core";

export const authQuery = customQuery(query, auth.ctx());
export const authMutation = customMutation(mutation, auth.ctx());
export const authAction = customAction(action, auth.ctx());
```

Inside those handlers, `ctx.auth` includes
`{ userId, user, groupId, role, grants }` and unauthenticated callers are
rejected before your handler runs.

## API layers

| Layer                | What it is                                                        | Typical usage                                                               |
| -------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Auth-flow actions    | Required client-callable functions exported from `convex/auth.ts` | `api.auth.signIn`, `api.auth.signOut`                                       |
| Internal auth action | Internal runtime mutation exported from `convex/auth.ts`          | `internal.auth.store`                                                       |
| Helper namespaces    | Server-side helper APIs returned by `defineAuth(...)`             | `auth.member.assert(ctx, { ... })`, `auth.connection.create(ctx, { data })` |
| App-owned admin RPC  | Optional public RPC for group connection admin UI                 | `authMutation`/`authQuery` functions calling `auth.connection.*`            |

Only the first layer is required for the frontend auth client. The third layer
exists only if your app explicitly exposes app-owned group connection admin
RPC by writing `authMutation`/`authQuery` functions over the `auth.connection.*`
facade.

`auth.oauth.*` is the app-as-authorization-server surface: it backs OAuth
client registration and the authorization-code, token, and refresh flows for
your app's own OAuth clients (for example MCP servers and Dynamic Client
Registration). It is wired into the `/oauth2/*` HTTP routes mounted by
`auth.http()`. Full OIDC provider-mode federation — third-party
`/userinfo` and standard-claim ID tokens for external relying parties — is still
future work.

## Multi-access model

Every auth path resolves to the same `userId`:

| Access pattern                     | How `userId` is available                                       |
| ---------------------------------- | --------------------------------------------------------------- |
| Browser (password, OAuth, passkey) | `ctx.auth.userId` via `auth.ctx()`                              |
| Group SSO (OIDC / SAML)            | Same as browser - SSO completes as a session                    |
| Device flow (CLI / IoT)            | Same as browser - device poll returns session tokens            |
| API key (machine / automation)     | `ctx.key.userId` or `auth.request.context(ctx, request).userId` |

The `userId` is the single shared anchor — server logic works regardless of how
the caller authenticated. In app code, prefer `auth.ctx()` and
`ctx.auth.userId`. Use `auth.request.context(ctx, request)` for advanced raw HTTP
handlers that accept either a session or an API key.
