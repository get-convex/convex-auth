---
title: SSO Overview
description: Group Connection Single Sign-On — OIDC, SAML 2.0, and SCIM 2.0 provisioning.
---

<svelte:head>

  <title>SSO Overview - convex-auth</title>
</svelte:head>

# SSO Overview

Group SSO is gated behind the `connection()` provider. The `auth.connection.*` namespace
is **only available** when `SSO` is included in your providers list:

```ts
import { defineAuth } from "@robelest/convex-auth/component";
import { connection } from "@robelest/convex-auth/providers";
import { components } from "./_generated/api";

const auth = defineAuth(components.auth, {
  providers: [
    connection({
      redirectURI: "/auth/connection/callback",
    }),
  ],
});
```

If `SSO` is not in your providers, accessing `auth.connection` will be a
TypeScript error — the namespace does not exist on the type.

The `auth.connection.*` namespace is the canonical server-side group SSO facade.
If your app wants a client-callable group SSO management API, expose it
explicitly from your Convex app. See the [Group SSO RPC guide](/connection/rpc/).

> **Server facade vs app-owned RPC**
>
> - `auth.connection.*` is the server-side facade namespace for Convex code.
> - `api.auth.group.*` is optional public RPC only after you expose app-owned
>   group SSO wrappers.
> - The frontend auth client only needs `api.auth.signIn` and
>   `api.auth.signOut`.

For the common case, create a single app-owned file such as
`convex/auth/group.ts` and export the group SSO functions your app needs. Each
admin function is an ordinary `authMutation` / `authQuery` (or `authAction` for
network-bound protocol calls) that authorizes with `auth.member.assert` and
forwards to the `auth.connection.*` facade:

```ts
// convex/auth/group.ts
import { v } from "convex/values";
import { query } from "./_generated/server";
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

export const setOidc = authMutation({
  args: { connectionId: v.string(), discovery: v.any(), client: v.any() },
  handler: async (ctx, args) => {
    const connection = await auth.connection.get(ctx, { id: args.connectionId });
    await auth.member.assert(ctx, {
      userId: ctx.auth.userId,
      groupId: connection!.groupId,
      grants: ["connection.protocol.manage"],
    });
    return auth.connection.oidc.upsert(ctx, args);
  },
});

// Public, no auth — plain `query`:
export const signIn = query({
  args: { domain: v.optional(v.string()), redirectTo: v.optional(v.string()) },
  handler: (ctx, args) => auth.connection.signIn(ctx, args),
});
```

After exporting those wrappers, frontend code can use normal Convex hooks/calls:

```ts
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

const createConnection = useMutation(api.auth.group.createConnection);
const setOidc = useMutation(api.auth.group.setOidc);
const signIn = useQuery(api.auth.group.signIn, {
  domain: "acme.com",
  redirectTo: "/dashboard",
});
```

`createConnection` requires a `groupId`, so create the group first or read it
from the current route/context before calling the RPC.

## What SSO covers

| Protocol | Purpose                                  | Namespace                                   |
| -------- | ---------------------------------------- | ------------------------------------------- |
| OIDC     | OpenID Connect identity provider login   | [`auth.connection.oidc`](/connection/oidc/) |
| SAML 2.0 | Security Assertion Markup Language login | [`auth.connection.saml`](/connection/saml/) |
| SCIM 2.0 | Cross-domain user/group provisioning     | [`auth.connection.scim`](/connection/scim/) |

## Unified model

All three protocols now follow the same mental model:

1. Protocol config extracts external identity
2. [`auth.connection.policy`](/connection/policy/) decides how that identity is applied
3. Verified domains establish trust for discovery and safe linking
4. Optional `sso.hooks` run on normalized profiles during provisioning

That means:

- OIDC / SAML / SCIM configure how to read external identity
- `policy` decides how users, memberships, and deprovisioning behave
- domains decide whether a connection is trusted for domain-based discovery
- hooks let your app customize the normalized provisioning pipeline

## Per-tenant runtime configuration

All group SSO configuration is **per-tenant runtime state** stored in your
Convex database. There is no app-level configuration file needed. Each tenant
(group) can have its own group connection record with its own IdP settings.

`auth.connection.create(...)` returns an object with `connectionId` and
`groupId`. Use `connectionId` for the rest of the `auth.connection.*` APIs.

If you expose app-owned group SSO functions, create the group first and then
call `createConnection({ groupId, ... })` with your app's authorization check.

This means you can:

- Onboard new group customers without redeploying.
- Support multiple IdPs across different tenants simultaneously.
- Let tenant admins configure their own SSO via your UI.

## Current policy scope

Today `auth.connection.policy` covers:

- OIDC and SAML account linking
- user creation and profile authority
- SCIM user reuse
- JIT user and membership creation
- groups and roles mapping into membership `roleIds`
- SCIM deprovision behavior

Protocol-specific transport and validation settings stay in:

- [`auth.connection.oidc`](/connection/oidc/)
- [`auth.connection.saml`](/connection/saml/)
- [`auth.connection.scim`](/connection/scim/)

`groups` and `roles` currently map external values into membership `roleIds`.
They do not create or mirror nested app groups automatically.

If you expose app-level SSO management functions, require tenant-admin
authorization in addition to checking that the caller is signed in.

## Hooks

You can optionally attach normalized SSO hooks at auth creation time:

```ts
const auth = defineAuth(components.auth, {
  providers: [connection()],
  sso: {
    hooks: {
      profileResolved: async ({ protocol, profile }) => profile,
      beforeProvision: async ({ protocol, profile }) => profile,
      afterProvision: async ({ protocol, userId }) => {},
      allowLink: async ({ protocol, userId, profile }) => true,
    },
  },
});
```

These hooks run on normalized profile objects rather than raw OIDC claims, SAML
attributes, or SCIM request bodies.

Use hooks when your app needs small provisioning customizations without pushing
tenant-specific logic down into protocol config.

## Related namespaces

| Namespace                                         | Purpose                                   |
| ------------------------------------------------- | ----------------------------------------- |
| [`auth.connection`](/connection/connection/)      | Manage SSO connections per group          |
| [`auth.connection.policy`](/connection/policy/)   | Manage group SSO behavior                 |
| [`auth.connection.oidc`](/connection/oidc/)       | Configure and validate OIDC providers     |
| [`auth.connection.saml`](/connection/saml/)       | Configure and validate SAML 2.0 providers |
| [`auth.connection.signIn`](/connection/rpc/)      | Resolve group SSO sign-in routes          |
| [`auth.connection.metadata`](/connection/rpc/)    | Generate SAML SP metadata                 |
| [`auth.connection.scim`](/connection/scim/)       | Configure SCIM 2.0 provisioning           |
| [`auth.event`](/connection/audit/)                | Query SSO audit events                    |
| [`auth.connection.webhook`](/connection/webhook/) | Manage webhook endpoints                  |
