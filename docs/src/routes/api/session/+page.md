---
title: auth.session
description: Session management — read, list, and revoke sessions.
---

<svelte:head>

  <title>auth.session - convex-auth</title>
</svelte:head>

# auth.session

The `auth.session` namespace provides methods for managing user sessions.

The `ctx.auth` examples on this page assume the handler is using `auth.ctx()`-
backed builders such as `authQuery`, `authMutation`, or `authAction`.

## Methods

| Method   | Signature                    | Returns                  | Description                                                                                     |
| -------- | ---------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `id`     | `(ctx)`                      | `Id<"Session"> \| null`  | Current session id, or `null` when unauthenticated. Pairs with `auth.user.id(ctx)`.             |
| `revoke` | `(ctx, { userId, except? })` | `{ userId, except }`     | Revokes all sessions for a user. Pass `except` as an array of session IDs to keep those active. |
| `get`    | `(ctx, { id })`              | `Doc<"Session"> \| null` | Reads a session document by ID.                                                                 |
| `list`   | `(ctx, { userId })`          | `Doc<"Session">[]`       | Lists all sessions for a user.                                                                  |

## Examples

### Read the current session ID

```ts
// Preferred — resolves the session id without parsing identity claims.
const sessionId = await auth.session.id(ctx); // Id<"Session"> | null
```

The legacy way still works:

```ts
const identity = await ctx.auth.getUserIdentity();
const sessionId = identity?.sid;
```

### Revoke all other sessions

This is useful for a "sign out everywhere else" feature:

```ts
const identity = await ctx.auth.getUserIdentity();
const sessionId = identity?.sid;
if (!sessionId) {
  throw new Error("Current session missing");
}

await auth.session.revoke(ctx, {
  userId: ctx.auth.userId,
  except: [sessionId],
});
```

### List all sessions for a user

```ts
const sessions = await auth.session.list(ctx, { userId: ctx.auth.userId });
```
