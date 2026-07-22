---
title: auth.connection.scim
description: SCIM 2.0 provisioning — configure directory sync and manage provisioned
  identities.
---

<svelte:head>

  <title>auth.connection.scim - convex-auth</title>
</svelte:head>

# auth.connection.scim

The `auth.connection.scim` namespace configures SCIM 2.0 provisioning for
automatic user and group synchronization from an identity provider's directory.

> This page documents the **server-side helper API**:
> [`auth.connection.scim.*`](/connection/scim/). Client-callable admin RPC like
> `api.auth.group.setScim` only exists after you expose it yourself —
> write an `authMutation` that authorizes with `auth.member.assert` and forwards
> to this facade, the same pattern as the rest of your app.

Use the `connectionId` returned by
[`auth.connection.create(...)`](/connection/connection/) when configuring SCIM.

The SCIM base URL is derived from your app's public site URL and the connection
ID. It is not an app-managed override.

The current SCIM surface is intentionally vendor-agnostic and focused on the
common interoperability subset:

- Users and Groups resources
- `PATCH` and `PUT`
- filters: `eq`, `co`, `sw`, `ew`, `pr`
- idempotent provisioning by `externalId`
- no `Bulk`
- no `ETag`

## Methods

| Method     | Signature                                               | Returns                                       | Description                                                                                         |
| ---------- | ------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `upsert`   | `(ctx, { connectionId, status?, security?, profile? })` | `{ connectionId, token, configId, basePath }` | Configures SCIM provisioning and returns the SCIM bearer token once.                                |
| `get`      | `(ctx, { connectionId })`                               | SCIM config document                          | Returns the current SCIM configuration for a connection.                                            |
| `status`   | `(ctx, { connectionId })`                               | `{ configured, ready, ... }`                  | Returns a lightweight readiness summary for a connection.                                           |
| `validate` | `(ctx, { connectionId })`                               | `{ checks: [...], capabilities }`             | Validates that the SCIM configuration is complete and returns the supported SCIM capability subset. |

## Example

### Configure SCIM for a connection

```ts
const { token } = await auth.connection.scim.upsert(ctx, {
  connectionId,
  security: {
    maxRequestSize: 200_000,
  },
  profile: {
    mapping: {
      externalId: "externalId",
      email: "emails.primary",
      name: "displayName",
      active: "active",
    },
    extraFields: {
      department: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",
    },
  },
});

const config = await auth.connection.scim.get(ctx, { connectionId });

// Provide these to the customer's IdP admin:
// config?.basePath — the SCIM base URL to configure in their directory
// token         — the authorization token for SCIM requests
```

The normalized SCIM profile then flows into
[`auth.connection.policy`](/connection/policy/) and optional `sso.hooks`, so extraction
stays separate from provisioning rules.

When `profile.mapping.groups` or `profile.mapping.roles` are configured,
external values can map into membership `roleIds` through policy.

## Status

```ts
const status = await auth.connection.scim.status(ctx, { connectionId });

status.configured;
status.ready;
status.capabilities;
status.checks;
```

Provisioning behavior such as deprovision mode is configured through
[`auth.connection.policy`](/connection/policy/), not
[`auth.connection.scim.upsert(...)`](/connection/scim/).
