## Features

- **Every auth method** — Password, Google/GitHub/Apple/Microsoft OAuth, magic
  links, passkeys, TOTP, anonymous, phone, device flow (RFC 8628)
- **Group SSO** — OIDC, SAML 2.0, SCIM 2.0 via the `auth.connection.*` admin
  facade
- **API keys** — Scoped permissions, per-key rate limiting, rotation, SHA-256
  hashing
- **Groups and memberships** — Hierarchical groups, permissions, grants, roles,
  invites, cascade operations
- **SSR** — Cookie-based auth for SvelteKit, TanStack Start, Next.js
- **Multi-access** — `auth.ctx()`, `auth.context(ctx)`, and
  `auth.request.context(ctx, request)` cover app, imperative, and raw HTTP auth
- **Convex component** — Isolated tables, typed helpers, zero-config defaults

## vNext preview

The vNext docs use the new Convex-native setup vocabulary:
`defineAuth`, `definePermissions`, `permissions`, `grants`, object args,
native Convex pagination, typed app env via `authEnv`, and a flat group
connection (SSO) admin facade `auth.connection.*`. See
[`packages/auth/MIGRATION-vNext.md`](./packages/auth/MIGRATION-vNext.md) for the
target shape and migration notes.

## API design

`@robelest/convex-auth` is a Convex component, but unlike single-purpose
components — which you instantiate as a class (`new RateLimiter(components.rateLimiter)`,
`new Resend(components.resend)`) — it spans many domains: users, sessions,
accounts, group memberships, SSO connections, OAuth clients, and API keys.
Rather than one class with dozens of methods, it uses a definition-first factory
that returns a facade namespaced by domain:

```ts
import { defineAuth } from "@robelest/convex-auth/server";
import { definePermissions } from "@robelest/convex-auth/permissions";
import { password, google } from "@robelest/convex-auth/providers";
import { components } from "./_generated/api";

export const permissions = definePermissions({
  grants: ["members.read", "sso.connection.manage"],
  roles: { admin: { label: "Admin", grants: ["members.read"] } },
});

export const auth = defineAuth(components.auth, {
  providers: [password(), google()],
  permissions,
});

// Every method is (ctx, objectArgs), grouped by domain:
await auth.user.get(ctx, { id });
await auth.member.assert(ctx, { userId, groupId, roleIds: ["admin"] });
await auth.connection.create(ctx, { groupId, protocol: "oidc" });
```

Configuration is passed once to `defineAuth`; related operations live under
`auth.user.*`, `auth.session.*`, `auth.account.*`, `auth.member.*`,
`auth.invite.*`, `auth.connection.*`, `auth.oauth.*`, `auth.key.*`, and
`auth.request.*`. All methods take Convex-native object args (`{ id }`,
`{ ids }`, `{ userId }`, `{ where }`, `{ paginationOpts }`, `{ data }`,
`{ patch }`) and return Convex-native shapes (`Doc | null`, `PaginationResult`).
`defineAuth` is the single canonical setup entry point — see
[`packages/auth/LEXICON.md`](./packages/auth/LEXICON.md) for the full naming and
shape contract.

## Package exports

| Import path                                          | Use                                                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `@robelest/convex-auth/server`                       | Backend: `defineAuth`, the `auth.*` facade, `authEnv`, `authEvents`, and HTTP route helpers                                |
| `@robelest/convex-auth/convex.config`                | The component definition for `app.use(auth)` in `convex.config.ts`                                                         |
| `@robelest/convex-auth/permissions`                  | `definePermissions` and the grant/role types                                                                               |
| `@robelest/convex-auth/providers` (+ `/providers/*`) | Auth providers: `password`, `google`, `github`, `apple`, `microsoft`, `passkey`, `totp`, `anonymous`, `email`, `device`, … |
| `@robelest/convex-auth/client`                       | Framework-agnostic browser client factory (`client()` — sign-in/out, token store)                                          |
| `@robelest/convex-auth/react`                        | React bindings: `ConvexAuthProvider`, `useAuth`, `useConvexAuthClient`                                                     |
| `@robelest/convex-auth/expo`                         | React Native / Expo client                                                                                                 |
| `@robelest/convex-auth/browser`                      | Low-level browser primitives (navigation, passkey, web locks)                                                              |
| `@robelest/convex-auth/core`                         | `createAuthContext` and low-level building blocks for custom integrations                                                  |

## Documentation

**[convex-auth.pages.dev](https://convex-auth.pages.dev)**

| Section                                                                        | Description                                                     |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| [Getting Started](https://convex-auth.pages.dev/getting-started/installation/) | Installation, providers, environment variables                  |
| [API Reference](https://convex-auth.pages.dev/api/user/)                       | `auth.user`, `auth.session`, `auth.group`, `auth.key`, and more |
| [Group SSO](https://convex-auth.pages.dev/connection/overview/)                | OIDC, SAML, SCIM, audit, webhooks                               |
| [SSR Integration](https://convex-auth.pages.dev/ssr/overview/)                 | SvelteKit, TanStack Start, Next.js                              |
| [Guides](https://convex-auth.pages.dev/guides/multi-access/)                   | Multi-access, device flow, authorization, production            |
| [Reference](https://convex-auth.pages.dev/reference/config/)                   | Config options, error codes, CLI, architecture                  |

## Contributing

```bash
pnpm install
vp run check
vp test --run --project convex
```

| Directory       | Description                                    |
| --------------- | ---------------------------------------------- |
| `packages/auth` | Auth component, server helpers, providers, CLI |
| `tests/`        | Vitest test suite (convex + node projects)     |
| `docs/`         | Starlight documentation site                   |

## License

[Apache-2.0](./LICENSE)
