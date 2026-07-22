---
title: auth.connection.oidc
description: OIDC provider configuration — discovery, claim mapping, and sign-in
  resolution.
---

<svelte:head>

  <title>auth.connection.oidc - convex-auth</title>
</svelte:head>

# auth.connection.oidc

The `auth.connection.oidc` namespace configures OpenID Connect identity providers
for SSO connections.

> This page documents the **server-side helper API**:
> [`auth.connection.oidc.*`](/connection/oidc/) plus the public
> [`auth.connection.signIn(...)`](/connection/rpc/) helper. Client-callable admin RPC
> like `api.auth.group.setOidc` only exists after you expose it yourself —
> write an `authMutation` that authorizes with `auth.member.assert` and forwards
> to this facade, the same pattern as the rest of your app.

Use the `connectionId` returned by
[`auth.connection.create(...)`](/connection/connection/) when configuring OIDC.

## Methods

| Method                          | Signature                                                                   | Returns                      | Description                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `auth.connection.oidc.upsert`   | `(ctx, { connectionId, discovery, client, request?, security?, profile? })` | OIDC config document         | Configures OIDC settings for a connection and stores the normalized config.                                      |
| `auth.connection.oidc.get`      | `(ctx, { connectionId })`                                                   | OIDC config document         | Returns the current OIDC configuration for a connection.                                                         |
| `auth.connection.oidc.status`   | `(ctx, { connectionId })`                                                   | `{ configured, ready, ... }` | Returns a lightweight readiness summary for a connection.                                                        |
| `auth.connection.oidc.validate` | `(ctx, { connectionId })`                                                   | `{ checks: [...] }`          | Validates that the OIDC configuration is complete and the IdP is reachable. Each check has its own `ok` field.   |
| `auth.connection.signIn`        | `(ctx, { connectionId?, email?, domain?, redirectTo?, loginHint? })`        | Sign-in route description    | Resolves the client-facing OIDC sign-in route for a connection. Domain/email routing requires a verified domain. |

`clientSecret` is write-only. Configure it through
[`auth.connection.oidc.upsert(...)`](/connection/oidc/), but expect
[`auth.connection.oidc.get(...)`](/connection/oidc/) and other public reads to return a
redacted view of the OIDC config.

If you use `connection({ redirectURI })`, multiple OIDC connections can share a single
callback URL while still routing back to the correct connection via the encoded
OIDC state.

## `upsert` shape

```ts
await auth.connection.oidc.upsert(ctx, {
  connectionId,
  discovery: {
    issuer: "https://login.example.com",
    discoveryUrl: "https://login.example.com/.well-known/openid-configuration",
    jwksUri: "https://login.example.com/keys",
    audience: ["client-id"],
  },
  client: {
    id: "client-id",
    secret: "client-secret",
    authMethod: "client_secret_basic",
  },
  request: {
    scopes: ["openid", "profile", "email"],
    loginHint: "user@example.com",
    authorizationParams: { prompt: "login" },
  },
  security: {
    clockToleranceSeconds: 300,
    strictIssuer: true,
  },
  profile: {
    mapping: {
      subject: "sub",
      email: "preferred_username",
      name: "display_name",
      groups: "groups",
      roles: "roles",
    },
    extraFields: {
      department: "department",
    },
  },
});
```

## Claim mapping

Use `profile.mapping` to override the core OIDC claims used for the built-in
profile:

```ts
await auth.connection.oidc.upsert(ctx, {
  connectionId,
  discovery: {
    issuer: "https://login.example.com",
  },
  client: {
    id: "...",
    secret: "...",
  },
  profile: {
    mapping: {
      subject: "sub",
      email: "preferred_username",
      name: "display_name",
    },
  },
});
```

Use `profile.extraFields` to map additional IdP claims to `user.extend` fields:

```ts
await auth.connection.oidc.upsert(ctx, {
  connectionId,
  discovery: {
    issuer: "https://login.microsoftonline.com/tenant-id/v2.0",
  },
  client: {
    id: "...",
    secret: "...",
  },
  profile: {
    extraFields: {
      department: "custom:department",
      jobTitle: "custom:job_title",
    },
  },
});
```

The keys are field names on your user document; the values are the claim names
from the IdP's ID token.

The normalized OIDC profile then flows into
[`auth.connection.policy`](/connection/policy/) and optional `sso.hooks`, so extraction
and provisioning stay separate.

## Login hints

Use `loginHint` to send a stable hint to the IdP, or pass it at sign-in time:

```ts
const route = await auth.connection.signIn(ctx, {
  connectionId,
  redirectTo: "/dashboard",
  loginHint: "user@example.com",
});

route.signInPath;
```

## Provider mode note

The library currently publishes issuer and JWKS metadata for provider-mode
discovery. Full provider endpoints such as `/oauth/authorize`, `/oauth/token`,
and `/userinfo` are still future work and should not be treated as generally
available yet.

## Validation

After configuring, validate that the connection is working:

```ts
const { checks } = await auth.connection.oidc.validate(ctx, { connectionId });

const failures = checks.filter((check) => !check.ok);
if (failures.length > 0) {
  console.error("OIDC validation failed:", failures);
}
```

## Status

```ts
const status = await auth.connection.oidc.status(ctx, { connectionId });

status.configured;
status.ready;
status.checks;
```

## Resolve a sign-in route

```ts
const route = await auth.connection.signIn(ctx, {
  connectionId,
  redirectTo: "/dashboard",
});

route.signInPath;
route.callbackPath;
```
