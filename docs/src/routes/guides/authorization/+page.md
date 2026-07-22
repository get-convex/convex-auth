---
title: Authorization Patterns
description: Identity, profile, and access control patterns.
---

<svelte:head>

  <title>Authorization Patterns - convex-auth</title>
</svelte:head>

# Authorization Patterns

Convex Auth keeps authorization simple. In vNext, define a permission system
with `definePermissions(...)`, pass it to `defineAuth({ permissions })`, assign
role ids to group memberships, and enforce access by checking grants with
`auth.member.assert(...)` or `auth.member.get(...)`.

Use the permissions vocabulary everywhere in new auth definitions.

## Define permissions

Use `definePermissions(...)` so grant strings and role ids stay typed everywhere
else in your app. Grants are the atomic permissions your code checks. Roles are
named bundles of grants that you assign to memberships and invites.

```ts
import { defineAuth } from "@robelest/convex-auth/server";
import { definePermissions } from "@robelest/convex-auth/permissions";

export const permissions = definePermissions({
  grants: [
    "members.create",
    "members.update",
    "members.delete",
    "members.read",
    "tickets.manage",
    "sso.connection.manage",
    "scim.manage",
  ],
  roles: {
    orgAdmin: {
      label: "Organization Admin",
      grants: [
        "members.create",
        "members.update",
        "members.delete",
        "members.read",
        "sso.connection.manage",
        "scim.manage",
      ],
    },
    support: {
      label: "Support",
      grants: ["members.read", "tickets.manage"],
    },
    member: {
      label: "Member",
      grants: ["members.read"],
    },
  },
});

export const auth = defineAuth(components.auth, {
  providers: [
    /* ... */
  ],
  permissions,
});
```

Role names are labels for humans. Grants are the contract your code should
trust.

## Assign roles with memberships

Memberships store `roleIds`. That keeps authorization attached to a user's
relationship with a group instead of scattering permission state across your own
tables.

```ts
await auth.member.create(ctx, {
  data: {
    userId,
    groupId: orgId,
    roleIds: [permissions.roles.orgAdmin.id],
  },
});
```

You update memberships the same way:

```ts
await auth.member.update(ctx, {
  id: memberId,
  patch: {
    roleIds: [permissions.roles.support.id],
  },
});
```

Invites can pre-assign role ids before the user joins:

```ts
await auth.invite.create(ctx, {
  data: {
    groupId: orgId,
    email: "alice@example.com",
    roleIds: [permissions.roles.member.id],
  },
});
```

## Use `userId` for authorization

Key authorization to `userId`, not email and not provider account ids. `userId`
is the stable identity in your app. Email is useful for lookup and onboarding,
but people change email addresses and some providers do not guarantee one.

If your app persists admin or support access outside memberships, store that
state by `userId`.

## What `getUserIdentity()` includes

`ctx.auth.getUserIdentity()` returns Convex identity claims from the JWT. The
token subject is the stable auth user id, and the token also mirrors common
profile claims such as `email`, `name`, and `picture` when they exist on the
user record.

Use those claims when you want native Convex auth ergonomics in backend code.
For the freshest profile data, prefer `ctx.auth.user` or `auth.user.viewer(ctx)`.

In app code, resolve authentication once with `auth.ctx()` and then use
`ctx.auth.userId` / `ctx.auth.user` in handlers.

## App-level denied sessions

Provider authentication and app authorization are separate decisions. If a user
successfully signs in but your app-level gate denies access (for example an
allowlist or billing check), call `auth.signOut()` immediately.

This clears the active session on both the client and the server, prevents the
browser from continuing to refresh a session your app does not intend to use,
and gives you a clean denied-state UI.

```ts
if (access.authenticated && !access.allowed) {
  await auth.signOut();
}
```

Keep the denial reason or email you want to display in local UI state before
signing out if the page needs to survive the unauthenticated rerender.

## Authorization pattern

These examples assume your handlers use auth-aware builders that inject
`ctx.auth` once in `convex/functions.ts`:

```ts
import { customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { mutation, query } from "./_generated/server";
import { auth } from "./auth";

export const authQuery = customQuery(query, auth.ctx());
export const authMutation = customMutation(mutation, auth.ctx());
```

```ts
import { authQuery } from "./functions";
import { auth } from "./auth";

export const canAccessAdminTools = authQuery({
  args: {},
  handler: async (ctx) => {
    const result = await auth.member.get(ctx, {
      userId: ctx.auth.userId,
      groupId: "group_id_here",
    });
    return result.grants.includes("admin.tools.read");
  },
});
```

Check grants instead of role names. A role name is a label. The grants attached
to it are the real contract.

```ts
// Use this when the handler should fail instead of returning a boolean.
await auth.member.assert(ctx, {
  userId: ctx.auth.userId,
  groupId: orgId,
  grants: ["sso.connection.manage"],
});
```

## Membership traversal

If your groups are nested, `auth.member.get(...)` can still resolve
inherited membership, but access decisions should usually be expressed in
grants.

```ts
const result = await auth.member.get(ctx, {
  userId: ctx.auth.userId,
  groupId: teamId,
});

if (result.grants.includes("members.read")) {
  // allow read access
}
```

## Performance: derive permissions from resolved grants

When you already have a user's resolved grants (e.g. from `member.get`), you
can derive permissions locally instead of making separate authorization calls:

```ts
const { grants } = await auth.member.get(ctx, {
  userId: ctx.auth.userId,
  groupId,
});

// Derive permissions from already-resolved grants (no extra DB reads)
const abilities = {
  canCreate: grants.includes("items.create"),
  canEdit: grants.includes("items.edit"),
  canDelete: grants.includes("items.delete"),
};
```

This avoids redundant round trips when you need to check multiple grants for the
same user and group.

## Group connection admin RPC

Group connection admin is exposed exactly like every other namespace: write
ordinary `authMutation` / `authQuery` / `authAction` functions that call the flat
`auth.connection.*` facade and authorize with `auth.member.assert`. There is no
special builder — the grant check lives directly in each handler.

```ts
// convex/auth/group.ts
import { v } from "convex/values";
import { auth } from "../auth";
import { authMutation } from "../functions";

export const createConnection = authMutation({
  args: {
    groupId: v.string(),
    protocol: v.union(v.literal("oidc"), v.literal("saml")),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await auth.member.assert(ctx, {
      userId: ctx.auth.userId,
      groupId: args.groupId,
      grants: ["connection.create"],
    });
    return auth.connection.create(ctx, args);
  },
});

export const setScim = authMutation({
  args: { connectionId: v.string(), profile: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const connection = await auth.connection.get(ctx, { id: args.connectionId });
    await auth.member.assert(ctx, {
      userId: ctx.auth.userId,
      groupId: connection!.groupId,
      grants: ["connection.protocol.manage"],
    });
    return auth.connection.scim.upsert(ctx, args);
  },
});
```

The `auth.member.assert(...)` check decides whether the caller may perform the
requested admin operation. Handlers use the same object args as the server
facade: `{ id }` for primary IDs, `{ connectionId }` for foreign-key scoped
operations, `{ data }` for payloads, and `paginationOpts` for unbounded lists.

## Account/User relationship

Accounts are many-to-one with users. One `User` can have many linked `Account`
records, such as GitHub, Google, and password. Each `Account` still belongs to
exactly one `User`.

This is why authorization should be keyed on `userId`, not provider account IDs.

## Common patterns

Use `auth.ctx()` when a handler should always receive `ctx.auth.userId` and
`ctx.auth.user`. Use `auth.member.get(...)` when you need a boolean-style
access check. Use `auth.member.assert(...)` when the handler should throw on
failure. Use `auth.ctx.optional()` when the same handler should work for
both guests and signed-in users.

## Recommended pattern

Define permissions once in config. Assign `roleIds` per membership. Check grants
in server functions. Treat role ids as labels and grants as the actual
authorization contract.

See [`auth.member`](/api/member) for the API surface and
[Group SSO RPC](/connection/rpc) for the app-owned admin flow.
