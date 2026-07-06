---
title: auth.event.list for SSO audit
description: Stream-backed SSO audit event projection queries.
---

<svelte:head>

  <title>auth.event.list for SSO audit - convex-auth</title>
</svelte:head>

# auth.event.list for SSO audit

SSO audit views read stream-backed event projections through `auth.event.list`.
Use typed scopes and function-builder filters so reads stay aligned with Convex
indexes.

App-owned admin RPC may wrap `auth.connection.audit.list` for convenience, but
the canonical server facade is `auth.event.list(ctx, { where, paginationOpts })`.

## Methods

| Method | Signature                                                                | Returns                                  | Description                       |
| ------ | ------------------------------------------------------------------------ | ---------------------------------------- | --------------------------------- |
| `list` | `(ctx, { where: (q) => q.eq("target", scope), paginationOpts, order? })` | `{ page, isDone, continueCursor }` event | Lists redacted event projections. |

## Example

### Query audit logs

```ts
import { auth, authEvents } from "./auth";

const connectionLogs = await auth.event.list(ctx, {
  where: (q) => q.eq("target", authEvents.target.connection(connectionId)),
  paginationOpts: { numItems: 50, cursor: null },
});

const failedSsoLogins = await auth.event.list(ctx, {
  where: (q) =>
    q
      .eq("target", authEvents.target.connection(connectionId))
      .eq("kind", authEvents.connection.loginFailed)
      .eq("outcome", "failure"),
  order: "desc",
  paginationOpts: { numItems: 50, cursor: null },
});
```
