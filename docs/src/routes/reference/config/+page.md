---
title: Configuration
description: defineAuth options reference.
---

<script>
  import Card from '$lib/components/docs/Card.svelte';
  import CardGrid from '$lib/components/docs/CardGrid.svelte';
</script>

<svelte:head>

  <title>Configuration - convex-auth</title>
</svelte:head>

# Configuration

## `defineAuth(component, config)`

`defineAuth` is the vNext preview setup surface. It is the preferred way to
describe the app's auth primitive: providers, permissions, table extensions,
and HTTP intent live on one typed definition.

Current stable releases may still expose `defineAuth`. Treat `defineAuth` and
`definePermissions` as the vNext target vocabulary while the implementation
lands.

```ts
import { authEvents, defineAuth } from "@robelest/convex-auth/server";
import { definePermissions } from "@robelest/convex-auth/permissions";
import { password } from "@robelest/convex-auth/providers";
import { components } from "./_generated/api";
import { v } from "convex/values";

const permissions = definePermissions({
  grants: ["members.read", "sso.connection.manage"],
  roles: {
    member: {
      label: "Member",
      grants: ["members.read"],
    },
    admin: {
      label: "Admin",
      grants: ["members.read", "sso.connection.manage"],
    },
  },
});

const auth = defineAuth(components.auth, {
  providers: [password()],
  permissions,
  extend: {
    User: v.object({ stripeCustomerId: v.optional(v.string()) }),
  },
  session: {
    totalDurationMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    inactiveDurationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
  jwt: {
    durationMs: 60 * 1000, // 1 minute
  },
  signIn: {
    maxFailedAttemptsPerHour: 10,
  },
  events: authEvents.handlers({
    user: {
      created: async (ctx, event) => {
        await enqueueOnboarding(ctx, { userId: event.subject.id });
      },
    },
    password: {
      changed: async (ctx, event) => {
        await auditPasswordChange(ctx, { userId: event.subject.id });
      },
    },
  }),
  path: "/auth",
});
```

## Config options

| Option                            | Type                                                | Default   | Description                                                                                                                                                            |
| --------------------------------- | --------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers`                       | `AuthProviderConfig[]`                              | required  | Auth methods to enable                                                                                                                                                 |
| `permissions`                     | `PermissionsDefinition`                             | `{}`      | App-defined grants and role bundles from `definePermissions(...)`.                                                                                                     |
| `extend`                          | `{ User?, Group?, GroupMember? }` Convex validators | `{}`      | Validator for each table's `extend` field. Types `auth.v.*` (so `viewer.extend.<field>` is typed) and validates return shapes.                                         |
| `session.totalDurationMs`         | `number`                                            | 30 days   | Maximum session lifetime                                                                                                                                               |
| `session.inactiveDurationMs`      | `number`                                            | varies    | Inactive session timeout                                                                                                                                               |
| `jwt.durationMs`                  | `number`                                            | 60s       | JWT token lifetime                                                                                                                                                     |
| `signIn.maxFailedAttemptsPerHour` | `number`                                            | 10        | Failed sign-in throttle (backed by `@convex-dev/rate-limiter` token bucket; resets on successful sign-in)                                                              |
| `events`                          | `AuthEventHandlerMap`                               | —         | Stream-backed lifecycle handlers from `authEvents.handlers(...)`.                                                                                                      |
| `path`                            | `string`                                            | `"/auth"` | HTTP path where the app-owned auth protocol routes are mounted. Provider callbacks, the JWT issuer, OAuth discovery, and `auth.request.mount(http)` all use this path. |

> **Note:** Email transport is configured via `email({ from, send })` in the
> providers array, not as a top-level config option.

See [Authorization Patterns](/guides/authorization) for the recommended
authorization model.

## Return value

`defineAuth` returns an object with:

- `signIn` — Action for client sign-in
- `signOut` — Action for client sign-out
- `store` — Internal runtime mutation for session token exchange
- `auth.user.*` — User helpers
- `auth.session.*` — Session helpers
- `auth.account.*` — Account helpers
- `auth.group.*` — Group helpers
- `auth.member.*` — Membership helpers
- `auth.invite.*` — Invite helpers
- `auth.key.*` — API key helpers
- `auth.request.*` — HTTP route helpers
- `auth.http()` — app-owned HTTP router for OAuth callbacks, JWKS, and protocol
  routes
- `auth.v.*` — Convex `returns:` validators for the read surface
  (`user`, `group`, `member`, `invite`, `viewer`, `list`). See
  [Typed Returns](/reference/typed-returns).
- `auth.connection.*` — group connection (SSO) admin facade when `connection()` is in providers
- `InferClientApi<typeof auth>` — Type-level utility; use as the generic for
  `client()` on the frontend to get conditional passkey/totp/device helpers
- `Doc`, `Viewer`, `Group`, `Membership` — exported document types
  (extend-aware), importable from `@robelest/convex-auth/server`

## Per-provider OAuth options

OAuth provider factories (`google`, `github`, `apple`, `microsoft`,
`custom`) accept these common options in addition to provider-specific
fields:

| Option                 | Type                        | Default           | Description                                                                                                                                                             |
| ---------------------- | --------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redirectUri`          | `string`                    | derived           | Callback URL override. Defaults to `${CONVEX_SITE_URL}/auth/callback/<provider>`.                                                                                       |
| `scopes`               | `string[]`                  | provider-default  | OAuth scopes requested at the authorize step.                                                                                                                           |
| `accountLinking`       | `"verifiedEmail" \| "none"` | `"verifiedEmail"` | On first sign-in, link to an existing user if the verified email matches.                                                                                               |
| `updateProfileOnLogin` | `boolean`                   | `true`            | On a returning sign-in, refresh `User.name`/`image`/`email` from the new profile. Set `false` if your app owns the canonical profile. Behavior matches Auth.js / Clerk. |

For SSO connections, the equivalent of `updateProfileOnLogin` lives on the
group connection policy under
`policy.provisioning.user.updateProfileOnLogin`.

## API layers

<CardGrid>
  <Card title="Auth-flow actions">
    <code>signIn</code> and <code>signOut</code> are the app-facing Convex functions used by the frontend auth
    client.
  </Card>
  <Card title="Helper namespaces">
    <code>auth.*</code>, <code>auth.connection.*</code>, and <code>auth.connection.scim.*</code> are server-side helper APIs for
    your Convex code.
  </Card>
  <Card title="App-owned admin RPC">
    Expose admin operations with your own <code>authMutation</code>/<code>authQuery</code> functions calling the <code>auth.connection.*</code> facade.
  </Card>
</CardGrid>

The `auth.connection.*` namespace is a server-side helper API. It is not
automatically exposed as client-callable Convex functions just because it
exists on the returned object.

If your app wants public group connection admin RPC, expose it explicitly by
writing `authMutation`/`authQuery` functions that authorize with
`auth.member.assert` and call the `auth.connection.*` facade — for example in
`convex/auth/group.ts`.

Use Convex-native args on those wrappers: `{ id }` for primary IDs,
`{ connectionId }` for foreign-key scoped operations, `{ data }` for
create/update payloads, and `paginationOpts` for unbounded lists.
