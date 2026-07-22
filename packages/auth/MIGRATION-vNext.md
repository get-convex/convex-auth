# vNext Migration Guide

This preview release makes the public API match Convex function conventions:
definition-first setup, object args, explicit primary IDs, native pagination,
typed app env, and permissions-first group authorization.

This is a hard breaking cut: removed names are not kept as compatibility aliases.

## Setup: `defineAuth` and `definePermissions`

The preferred vNext setup surface is `defineAuth`. It keeps providers,
permissions, table extensions, and HTTP intent on one typed auth definition.

```ts
// Before
import { defineRoles } from "@robelest/convex-auth/authorization";
import { createAuth } from "@robelest/convex-auth/server";

export const roles = defineRoles({
  admin: {
    label: "Admin",
    grants: ["members.read", "sso.connection.manage"],
  },
});

export const auth = createAuth(components.auth, {
  providers: [password()],
  authorization: { roles },
});
```

```ts
// vNext
import { defineAuth } from "@robelest/convex-auth/server";
import { definePermissions } from "@robelest/convex-auth/permissions";

export const permissions = definePermissions({
  grants: ["members.read", "sso.connection.manage"],
  roles: {
    admin: {
      label: "Admin",
      grants: ["members.read", "sso.connection.manage"],
    },
  },
});

export const auth = defineAuth(components.auth, {
  providers: [password()],
  permissions,
});
```

Use these nouns consistently:

- `permissions` is the configured permission system.
- `grants` are atomic strings checked by app code.
- `roles` are named bundles of grants assigned to memberships and invites.
- `authorization: { roles }` was removed with the old setup vocabulary.

## Object args everywhere

Primary entity IDs now use `{ id }`. Batch reads use `{ ids }`. Foreign keys
keep their entity prefix, such as `{ userId }` or `{ groupId }`.

```ts
// Before
await auth.user.get(ctx, userId);
await auth.user.update(ctx, userId, patch);
await auth.key.verify(ctx, secret);

// vNext
await auth.user.get(ctx, { id: userId });
await auth.user.update(ctx, { id: userId, patch });
await auth.key.verify(ctx, { secret });
```

## Native pagination

Unbounded list APIs now accept `paginationOpts` and return Convex's
`PaginationResult` shape.

```ts
// Before
const { items, nextCursor } = await auth.user.list(ctx, {
  limit: 25,
  cursor,
});

// vNext
const { page, isDone, continueCursor } = await auth.user.list(ctx, {
  paginationOpts: { numItems: 25, cursor },
});
```

Pass the same args directly to `usePaginatedQuery` for component-backed
functions.

## Filters and payloads

List filters live under `where`, create payloads use `data`, update payloads
use `patch`, and update payload validators are partial.

```ts
await auth.member.update(ctx, {
  id: memberId,
  patch: { roleIds: ["support"] },
});

const pending = await auth.invite.list(ctx, {
  where: { groupId, status: "pending" },
  paginationOpts: { numItems: 25, cursor: null },
});
```

## Typed Convex env

Import `authEnv` into your app definition and read generated env values from
`convex/_generated/server`.

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import { authEnv } from "@robelest/convex-auth/server";
import auth from "@robelest/convex-auth/convex.config";

const app = defineApp({ env: authEnv });
app.use(auth, { name: "auth" });

export default app;
```

```ts
import { env } from "./_generated/server";

const appUrl = env.APP_URL;
```

## Connection (SSO) admin APIs

There is no mount layer. Group connection admin is exposed exactly like the rest
of your app: write `authMutation`/`authQuery` functions that authorize with
`auth.member.assert` and call the flat `auth.connection.*` facade. `groupId` and
`connectionId` are arguments, not path segments.

```ts
// Before — bespoke mount surface (removed)
export const sso = auth.sso.mount({
  access: async (ctx, input) => {
    /* … */
  },
});
export const configureOidc = sso.admin.oidc.configure;
export const configureScim = sso.admin.scim.configure;
```

```ts
// Now — convex/auth/group.ts: the same authMutation pattern as the rest of your app
import { v } from "convex/values";
import { authMutation } from "../functions";
import { auth } from "../auth";
import { roles } from "../roles";

export const createConnection = authMutation({
  args: { groupId: v.string(), protocol: v.union(v.literal("oidc"), v.literal("saml")) },
  handler: async (ctx, args) => {
    await auth.member.assert(ctx, {
      userId: ctx.auth.userId,
      groupId: args.groupId,
      roleIds: [roles.orgAdmin.id],
    });
    return auth.connection.create(ctx, args);
  },
});

export const setOidc = authMutation({
  args: { connectionId: v.string() /* discovery, client, … */ },
  handler: async (ctx, args) => {
    const { groupId } = await auth.connection.get(ctx, { id: args.connectionId });
    await auth.member.assert(ctx, {
      userId: ctx.auth.userId,
      groupId,
      roleIds: [roles.orgAdmin.id],
    });
    return auth.connection.oidc.upsert(ctx, args);
  },
});

export const setScim = authMutation({
  args: { connectionId: v.string() },
  handler: async (ctx, args) => {
    const { groupId } = await auth.connection.get(ctx, { id: args.connectionId });
    await auth.member.assert(ctx, {
      userId: ctx.auth.userId,
      groupId,
      roleIds: [roles.orgAdmin.id],
    });
    return auth.connection.scim.upsert(ctx, args);
  },
});
```

Expose only the helpers your app's UI calls. Use Convex-native args: `{ id }` for
the primary record, `{ connectionId }` for a foreign key, `{ data }` for create
payloads, `{ patch }` for update payloads, and `paginationOpts` for unbounded
lists.

## HTTP and routing

Keep app-owned HTTP routes explicit. Use typed env in `defineApp({ env:
authEnv })`, mount the auth component with Convex component options, and expose
auth HTTP routes from the app's `convex/http.ts`.

```ts
// convex/convex.config.ts
const app = defineApp({ env: authEnv });
app.use(authComponent, { name: "auth", httpPrefix: "/auth" });
```

```ts
// convex/http.ts
const http = auth.http();
export default http;
```

Route helpers such as `auth.request.context(...)` and
`auth.request.route(...)` remain the way to protect app-owned HTTP handlers.

## Naming checklist

- Prefer `defineAuth` for the vNext auth definition.
- Prefer `definePermissions` and `permissions` over
  `authorization: { roles }`.
- Use `id` for the primary row ID.
- Use `ids` for batch primary ID reads.
- Use `<entity>Id` only for foreign keys.
- Use `where` for list filters.
- Use `paginationOpts` for unbounded lists.
- Use `data` for create payloads.
- Use `patch` for update payloads.
