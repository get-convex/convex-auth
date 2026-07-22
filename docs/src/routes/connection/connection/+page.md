---
title: auth.connection
description: SSO connection management — create and manage per-tenant SSO connections.
---

<svelte:head>

  <title>auth.connection - convex-auth</title>
</svelte:head>

# auth.connection

The `auth.connection` namespace manages group SSO records. Each record
links a group (tenant) to an identity provider configuration. It is also the
root namespace for group connection domain management through
[`auth.connection.domain.*`](/connection/connection/). The returned
`connectionId` is passed to the rest of the group SSO APIs.

> This page documents the **server-side helper API**:
> [`auth.connection.*`](/connection/connection/). If you want client-callable admin RPC
> like `api.auth.group.createConnection`, expose it yourself — write an
> `authMutation` / `authQuery` that authorizes with `auth.member.assert` and
> forwards to this facade, the same pattern as the rest of your app.

## Methods

| Method   | Signature                                                  | Returns                            | Description                                                   |
| -------- | ---------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| `create` | `(ctx, { groupId, slug?, name?, status?, domains?, ... })` | `{ connectionId, groupId }`        | Creates a new SSO connection for a group.                     |
| `get`    | `(ctx, { id })` or `(ctx, { domain })`                     | `Doc \| null`                      | Reads a connection by ID or verified domain selector.         |
| `list`   | `(ctx, { where?, paginationOpts, orderBy?, order? })`      | `{ page, isDone, continueCursor }` | Lists SSO connections with optional filtering and sorting.    |
| `update` | `(ctx, { id, patch })`                                     | `{ connectionId }`                 | Updates connection fields (status, metadata, domains, etc.).  |
| `remove` | `(ctx, { id })`                                            | `{ connectionId }`                 | Deletes an SSO connection.                                    |
| `status` | `(ctx, { id })`                                            | Status object                      | Returns readiness and per-protocol status for the connection. |

## Domain methods

The [`auth.connection.domain`](/connection/connection/) namespace manages
domains owned by the connection.

| Method                 | Signature                          | Returns                     | Description                                                                     |
| ---------------------- | ---------------------------------- | --------------------------- | ------------------------------------------------------------------------------- |
| `list`                 | `(ctx, { connectionId })`          | Domain list                 | Lists domains attached to the connection.                                       |
| `status`               | `(ctx, { connectionId })`          | Onboarding status           | Returns trust status, pending challenges, warnings, and recommended next steps. |
| `validate`             | `(ctx, { connectionId })`          | Status info                 | Returns onboarding diagnostics for domains.                                     |
| `upsert`               | `(ctx, { connectionId, domains })` | `{ connectionId, domains }` | Replaces the connection's full domain set and returns the canonical result.     |
| `verification.request` | `(ctx, { connectionId, domain })`  | Verification challenge      | Issues a DNS TXT verification challenge for an attached domain.                 |
| `verification.confirm` | `(ctx, { connectionId, domain })`  | Confirmation result         | Resolves the TXT record and marks the domain verified on success.               |

## Example

```ts
// Create an SSO connection for a tenant
const { connectionId } = await auth.connection.create(ctx, {
  groupId: orgId,
  slug: "acme",
  name: "Acme SSO",
  status: "active",
});

// Replace the attached group connection domains
const domainResult = await auth.connection.domain.upsert(ctx, {
  connectionId,
  domains: [{ domain: "acme.com", isPrimary: true }, { domain: "login.acme.com" }],
});

const challenge = await auth.connection.domain.verification.request(ctx, {
  connectionId,
  domain: "acme.com",
});

const confirmation = await auth.connection.domain.verification.confirm(ctx, {
  connectionId,
  domain: "acme.com",
});

const domains = await auth.connection.domain.list(ctx, { connectionId });

const domainStatus = await auth.connection.domain.status(ctx, { connectionId });

// Inspect domain onboarding readiness
const diagnostics = await auth.connection.domain.validate(ctx, { connectionId });

// Check connection health
const status = await auth.connection.status(ctx, { id: connectionId });
```

## Trust semantics

Verified domains establish trusted ownership for a connection.

- domain-based SSO discovery should rely on verified domains
- primary-domain verification is the clearest signal that a connection is ready
- automatic account linking is only safe when your linking policy allows it and
  the connection has verified domain ownership

Use `domain.status(...)` when building onboarding UIs. It returns the current
primary domain, verified domains, pending DNS challenges, warnings, and the next
recommended admin steps.

`verification.request(...)` also acts as the renewal path for expired TXT
challenges.
