---
title: auth.account
description: Account management — link/unlink providers, passkeys, and TOTP.
---

<svelte:head>

  <title>auth.account - convex-auth</title>
</svelte:head>

# auth.account

The `auth.account` namespace manages the link between users and authentication
methods. A user can have multiple accounts (e.g. password + Google OAuth),
passkey credentials, and TOTP enrollments.

## Account methods

| Method   | Signature                          | Returns                                | Description                                                                                                                                                                                                                                                |
| -------- | ---------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create` | `(ctx, { userId, provider, ... })` | `{ account, user }`                    | Links a new authentication provider to a user and returns the created account plus resolved user.                                                                                                                                                          |
| `link`   | `(ctx, { provider, profile })`     | `{ accountId, userId, alreadyLinked }` | Attaches a provider account to the **currently authenticated user**. Idempotent on duplicate links to the same user. Also folds in the "upgrade anonymous" flow: when the current user is anonymous, flips `isAnonymous: false` and merges profile fields. |
| `update` | `(ctx, { provider, account })`     | `{ accountId }`                        | Updates provider credentials, such as a password secret.                                                                                                                                                                                                   |
| `remove` | `(ctx, { id })`                    | `{ accountId }`                        | Deletes an account link. Throws `ConvexError` with code `ACCOUNT_NOT_FOUND` or `INVALID_PARAMETERS` on failure.                                                                                                                                            |

## Passkey methods

Manage WebAuthn passkey credentials. Requires `passkey()` in providers.

| Method           | Signature              | Returns             | Description                               |
| ---------------- | ---------------------- | ------------------- | ----------------------------------------- |
| `passkey.list`   | `(ctx, { userId })`    | `Doc<"passkeys">[]` | Lists all registered passkeys for a user. |
| `passkey.update` | `(ctx, { id, patch })` | `{ passkeyId }`     | Renames a passkey credential.             |
| `passkey.remove` | `(ctx, { id })`        | `{ passkeyId }`     | Deletes a passkey credential.             |

```ts
const passkeys = await auth.account.passkey.list(ctx, { userId });
await auth.account.passkey.remove(ctx, { id: passkeyId });
```

## TOTP methods

Manage TOTP two-factor authentication. Requires `totp()` in providers.

| Method        | Signature           | Returns          | Description                        |
| ------------- | ------------------- | ---------------- | ---------------------------------- |
| `totp.list`   | `(ctx, { userId })` | `Doc<"totps">[]` | Lists TOTP enrollments for a user. |
| `totp.remove` | `(ctx, { id })`     | `{ totpId }`     | Deletes a TOTP enrollment.         |

```ts
const totps = await auth.account.totp.list(ctx, { userId });
await auth.account.totp.remove(ctx, { id: totpId });
```

## Examples

### Link a new provider to the current user

```ts
// User signed in with password and wants to attach Google.
await auth.account.link(ctx, {
  provider: "google",
  profile: { id: googleSub, email, name, image },
});
```

`profile` must include at least one of `id`, `email`, or `phone` to derive
the provider account id. If the `(provider, providerAccountId)` is already
linked to a different user, throws `ConvexError` with code
`ACCOUNT_ALREADY_LINKED` — catch it and prompt the user to sign in to the
other account if you want to merge.

### Upgrade an anonymous account

`auth.account.link` detects an anonymous current user and finishes the
upgrade in the same call:

```ts
// User had an anonymous session; now linking real credentials.
await auth.account.link(ctx, {
  provider: "password",
  profile: { id: email, email, name },
});
// userId is unchanged. user.isAnonymous is now false.
// user.name / email are populated from the profile.
```

### Delete an account

```ts
import { ConvexError } from "convex/values";

try {
  const { accountId } = await auth.account.remove(ctx, { id: accountId });
} catch (error) {
  if (error instanceof ConvexError) {
    // error.data.code is "ACCOUNT_NOT_FOUND" or "INVALID_PARAMETERS"
    console.error(`Failed to delete account: ${error.data.code}`);
  }
  throw error;
}
```
