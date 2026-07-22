---
title: Group SSO RPC
description: App-owned client-callable group SSO RPC built from convex-auth server helpers.
---

<svelte:head>

  <title>Group SSO RPC - convex-auth</title>
</svelte:head>

# Group SSO RPC

`api.auth.group.*` is an optional, app-owned RPC surface for group admin UI and
group SSO sign-in flows.

It is **not** created automatically by `defineAuth(...)`.

- `auth.connection.*` is the server-side facade namespace
- `api.auth.group.*` exists only after your app exports Convex functions from a
  file such as `convex/auth/group.ts`

## When you need it

Use `api.auth.group.*` when your app needs client-callable functions for:

- creating and managing group SSO connections
- configuring OIDC, SAML, and SCIM from an admin UI
- validating group SSO setup from the browser
- resolving group SSO sign-in flows from app code

The app-owned RPC layer mirrors the server facade model:

- protocol namespaces (`oidc`, `saml`, `scim`) configure how external identity
  is read
- `policy` decides how users and memberships are provisioned
- connection and domain helpers manage trust and onboarding state

If you only need normal sign-in/sign-out, you do **not** need this surface. The
frontend auth client still only depends on:

- `api.auth.signIn`
- `api.auth.signOut`

## Recommended app file

Group connection admin is exposed exactly like every other namespace: write
ordinary `authMutation` / `authQuery` / `authAction` functions that call the
flat `auth.connection.*` facade and authorize with `auth.member.assert`. There
is no special builder. Create one app-owned file and export only what your app
needs:

```ts
// convex/auth/group.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { auth } from "../auth";
import { authAction, authMutation, authQuery } from "../functions";

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

export const getConnection = authQuery({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const connection = await auth.connection.get(ctx, { id: args.id });
    if (connection) {
      await auth.member.assert(ctx, {
        userId: ctx.auth.userId,
        groupId: connection.groupId,
        grants: ["connection.read"],
      });
    }
    return connection;
  },
});

export const setOidc = authMutation({
  args: {
    connectionId: v.string(),
    discovery: v.any(),
    client: v.any(),
    request: v.optional(v.any()),
    profile: v.optional(v.any()),
  },
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

// SAML configure runs in an action (it fetches IdP metadata over the network):
export const setSaml = authAction({
  args: { connectionId: v.string(), metadata: v.any(), profile: v.optional(v.any()) },
  handler: async (ctx, args) => {
    return auth.connection.saml.upsert(ctx, args);
  },
});

export const updatePolicy = authMutation({
  args: { groupId: v.string(), data: v.any() },
  handler: async (ctx, args) => {
    await auth.member.assert(ctx, {
      userId: ctx.auth.userId,
      groupId: args.groupId,
      grants: ["connection.policy.manage"],
    });
    return auth.connection.policy.update(ctx, { groupId: args.groupId, patch: args.data });
  },
});

// Public, pre-sign-in helpers — plain `query`, no authentication:
export const signIn = query({
  args: {
    connectionId: v.optional(v.string()),
    email: v.optional(v.string()),
    domain: v.optional(v.string()),
    redirectTo: v.optional(v.string()),
    loginHint: v.optional(v.string()),
  },
  handler: (ctx, args) => auth.connection.signIn(ctx, args),
});

export const metadata = query({
  args: { connectionId: v.string() },
  handler: (ctx, args) => auth.connection.metadata(ctx, args),
});
```

Repeat the same shape for the rest of the surface: every admin export is an
`authMutation` / `authQuery` (or `authAction` for network-bound protocol calls)
that authorizes with `auth.member.assert` and then forwards to the matching
`auth.connection.*` facade method. The public `signIn` and `metadata` helpers
stay plain `query` functions with no auth.

The facade keeps the same mental model as before:

- `configure*` reads external identity from a protocol
- `get*` and `status` expose the current normalized state
- `policy.update` controls how that identity is applied
- domain helpers manage trust and onboarding

Top-level `sso.hooks` remain server-only configuration on `defineAuth(...)`;
they are not part of the `api.auth.group.*` RPC surface.

## Client usage

Once exported, the functions show up in your generated Convex API like any other
app-owned functions:

```ts
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

const createConnection = useMutation(api.auth.group.createConnection);
const setOidc = useMutation(api.auth.group.setOidc);
const setScim = useMutation(api.auth.group.setScim);

const signIn = useQuery(api.auth.group.signIn, {
  domain: "acme.com",
  redirectTo: "/dashboard",
});
```

Whether an export is a query, mutation, or action depends on which builder you
used for it: protocol calls that reach out over the network (such as
`setSaml`) should be `authAction`, while pure database reads and writes are
`authQuery` / `authMutation`.

## Authorization

Each admin function authorizes itself with `auth.member.assert(ctx, { userId,
groupId, grants })`. There is no shared `access` policy and no builder — the
authorization check lives directly in the handler, just like every other
namespace.

See [Authorization Patterns](/guides/authorization) for how grant checks fit
into this group SSO pattern.

A typical admin function resolves the `groupId` (from the args, or by loading
the connection first), then requires the relevant grant:

```ts
// convex/auth/group.ts
export const updateConnection = authMutation({
  args: { id: v.string(), data: v.any() },
  handler: async (ctx, args) => {
    const connection = await auth.connection.get(ctx, { id: args.id });
    await auth.member.assert(ctx, {
      userId: ctx.auth.userId,
      groupId: connection!.groupId,
      grants: ["connection.manage"],
    });
    return auth.connection.update(ctx, { id: args.id, patch: args.data });
  },
});
```

`createConnection` requires a `groupId`; creating the group remains a separate
app concern via `auth.group.create(...)` or your own app-owned wrapper.

## What gets exported

Your app chooses the public names. A common set of verb-first functions:

### Connection

- `createConnection`
- `getConnection`
- `getConnectionByDomain`
- `listConnections`
- `updateConnection`
- `removeConnection`
- `getConnectionStatus`

### Domains

- `listDomains`
- `getDomainStatus`
- `validateDomains`
- `setDomains`
- `requestDomainVerification`
- `confirmDomainVerification`

### OIDC

- `setOidc`
- `getOidc`
- `getOidcStatus`
- `validateOidc`

### SAML

- `setSaml`
- `getSaml`
- `getSamlStatus`
- `validateSaml`
- `refreshSaml`
- `metadata`

### Policy

- `getPolicy`
- `updatePolicy`
- `validatePolicy`

### Audit and Webhooks

- `listAudit`
- `createWebhookEndpoint`
- `listWebhookEndpoints`
- `disableWebhookEndpoint`

### SCIM

- `setScim`
- `getScim`
- `getScimStatus`
- `validateScim`

### Client sign-in helpers

- `signIn`

## Example payloads

```ts
await setOidc({
  connectionId,
  discovery: { issuer: "https://login.example.com" },
  client: { id: "client-id", secret: "client-secret" },
  request: { scopes: ["openid", "profile", "email"] },
  profile: { mapping: { email: "email", groups: "groups", roles: "roles" } },
});

await setSaml({
  connectionId,
  metadata: { url: "https://idp.example.com/metadata.xml" },
  request: { signAuthnRequests: true },
  profile: { mapping: { subject: "UserID", email: "Email", roles: "Roles" } },
});

await setScim({
  connectionId,
  profile: { mapping: { externalId: "externalId", email: "emails.primary" } },
});
```

## Relationship to the facade

Your app-owned functions are a thin public layer over the flat server facade:

- `auth.connection.*`
- `auth.connection.oidc.*`
- `auth.connection.saml.*`
- `auth.connection.policy.*`
- `auth.event.*`
- `auth.connection.webhook.*`
- `auth.connection.signIn`
- `auth.connection.metadata`
- `auth.connection.scim.*`

If you need a custom public shape, write whatever Convex functions you like over
those facade methods. There is no required structure.

## Payload shapes

The facade methods use the same nested protocol config shapes throughout:

- OIDC: `discovery`, `client`, `request`, `security`, `profile`
- SAML: `metadata`, `request`, `security`, `serviceProvider`, `profile`
- SCIM: `status`, `security`, `profile`

This keeps your admin UI and your server-side usage on the same mental model.
