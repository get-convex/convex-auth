---
title: auth.key
description: API key management — create, verify, rotate, and scope keys.
---

<svelte:head>

  <title>auth.key - convex-auth</title>
</svelte:head>

# auth.key

The `auth.key` namespace manages API keys. Keys are SHA-256 hashed before
storage and are prefixed with `sk_` by default. Each key can carry scoped
permissions and optional per-key rate limiting.

## Methods

| Method   | Signature                                                                      | Returns                                                                | Description                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create` | `(ctx, { data: { userId, name, scopes, metadata?, rateLimit?, expiresAt? } })` | `{ id, secret }`                                                       | Creates a new API key. The secret key (with `sk_` prefix) is returned once.                                                                                 |
| `verify` | `(ctx, { secret })`                                                            | `{ userId, keyId, scopes }`                                            | Verifies a secret key string. Throws `ConvexError` with code `INVALID_API_KEY`, `API_KEY_REVOKED`, `API_KEY_EXPIRED`, or `API_KEY_RATE_LIMITED` on failure. |
| `list`   | `(ctx, { where?, paginationOpts, orderBy?, order? })`                          | `PaginationResult<Doc<"ApiKey">>` — `{ page, isDone, continueCursor }` | Lists keys for a user. Convex-native shape.                                                                                                                 |
| `get`    | `(ctx, { id })`                                                                | `KeyDoc \| null`                                                       | Reads a key document by ID (does not include the secret).                                                                                                   |
| `update` | `(ctx, { id, patch })`                                                         | `null`                                                                 | Updates key metadata, scopes, or rate limit.                                                                                                                |
| `revoke` | `(ctx, { id })`                                                                | `null`                                                                 | Revokes a key (soft delete — the key still exists but can no longer be verified).                                                                           |
| `remove` | `(ctx, { id })`                                                                | `null`                                                                 | Permanently deletes a key.                                                                                                                                  |
| `rotate` | `(ctx, { id })`                                                                | `{ id, secret }`                                                       | Generates a new secret for an existing key. Throws `ConvexError` with code `INVALID_PARAMETERS` or `API_KEY_REVOKED` on failure.                            |

## Scopes

Keys can be scoped with fine-grained permissions. Use `scopes.can()` to check:

```ts
import { ConvexError } from "convex/values";

try {
  const { scopes } = await auth.key.verify(ctx, { secret });

  if (!scopes.can("documents", "read")) {
    throw new Error("Insufficient permissions");
  }
} catch (error) {
  if (error instanceof ConvexError) {
    // error.data.code is "INVALID_API_KEY", "API_KEY_REVOKED", etc.
    throw new Error(`Key verification failed: ${error.data.code}`);
  }
  throw error;
}
```

## Examples

### Create a key with scopes

```ts
const { id, secret } = await auth.key.create(ctx, {
  data: {
    userId,
    name: "CI/CD Key",
    scopes: [{ resource: "documents", actions: ["read", "write"] }],
    extend: { environment: "production" },
  },
});

// secret = "sk_abc123..." — show this to the user once
```

### Verify a key from a request

```ts
import { ConvexError } from "convex/values";

const authHeader = request.headers.get("Authorization");
const secret = authHeader?.replace("Bearer ", "");

if (!secret) {
  throw new Error("Missing API key");
}

try {
  const { userId, scopes } = await auth.key.verify(ctx, { secret });
} catch (error) {
  if (error instanceof ConvexError) {
    throw new Error(`Invalid API key: ${error.data.code}`);
  }
  throw error;
}
```

### Per-key rate limiting

```ts
const { id, secret } = await auth.key.create(ctx, {
  data: {
    userId,
    name: "Rate-limited key",
    scopes: [],
    rateLimit: {
      maxRequests: 100,
      windowMs: 60_000, // 100 requests per minute
    },
  },
});
```

### Rotate a key

```ts
import { ConvexError } from "convex/values";

try {
  const { secret } = await auth.key.rotate(ctx, { id });
  // secret is the new key; the old secret is immediately invalid
} catch (error) {
  if (error instanceof ConvexError) {
    // error.data.code is "INVALID_PARAMETERS" or "API_KEY_REVOKED"
    throw new Error(`Key rotation failed: ${error.data.code}`);
  }
  throw error;
}
```

### Metadata

Each key can carry an arbitrary `metadata` object for storing additional context
like environment, project, or team:

```ts
await auth.key.update(ctx, {
  id: keyId,
  patch: {
    extend: { environment: "staging", project: "mobile-app" },
  },
});
```
