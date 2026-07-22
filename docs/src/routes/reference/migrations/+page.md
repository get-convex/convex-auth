---
title: Data Migrations
description: Run convex-auth's built-in data migrations after upgrading.
---

<svelte:head>

  <title>Data Migrations - convex-auth</title>
</svelte:head>

# Data Migrations

convex-auth owns its own Convex tables, so any data migration over them
runs **inside the component**. The component ships with the
[`@convex-dev/migrations`](https://www.convex.dev/components/migrations)
component mounted internally and exposes runners you trigger from the
CLI after upgrading.

You do not install or configure anything — the migration functions are
part of the `auth` component once you upgrade the package.

## `dropHasTotp`

Older versions stored a denormalized `User.hasTotp` boolean (a cache of
"has ≥1 verified TOTP"). It has been removed from the typed surface;
sign-in now resolves TOTP enrollment with an indexed query instead.

The field is **still tolerated in the schema** so pre-existing rows keep
validating after you upgrade — nothing breaks on deploy. To actually
strip the dead field from existing `User` documents, run:

```sh
npx convex run auth/migrations:runDropHasTotp '{}'
```

- **Idempotent** — rows without the field are skipped; safe to re-run.
- **Batched & resumable** — handled by the migrations component; large
  tables process in batches and resume if interrupted.
- **Dry run:** `npx convex run auth/migrations:runDropHasTotp '{"dryRun": true}'`
- **Production:** add `--prod` (`npx convex run --prod auth/migrations:runDropHasTotp '{}'`).

Once every deployment you operate has run this, the `hasTotp` field will
be removed from the component schema entirely in a future major. Until
then it remains optional and ignored — running the migration is
recommended but not required for the app to function.

> Note: this is unrelated to any `User.extend` fields your app declares
> (e.g. a consumer-defined `extend.lastActiveGroup`). convex-auth never
> migrates consumer `extend` data — that stays under your control.

## `disableLegacyWebhookEndpoints`

Preview versions stored `GroupWebhookEndpoint.secretHash` as a one-way SHA-256
hash. That value cannot be converted into the original HMAC signing secret and
must not be encrypted as though it were the secret.

After upgrading, run:

```sh
vp exec convex run auth/migrations:runDisableLegacyWebhookEndpoints '{}'
```

The migration disables every endpoint without `secretCiphertext` and erases
any obsolete `secretHash`. It is idempotent, batched, and resumable through the
migrations component. Runtime delivery also skips missing-ciphertext endpoints,
so legacy rows remain inert before the migration finishes.

To restore an endpoint, provide a new signing secret and explicitly activate
it:

```ts
await auth.connection.webhook.endpoint.update(ctx, {
  id: endpointId,
  patch: { secret: "whsec_new_...", status: "active" },
});
```

The original shared secret cannot be recovered. If you cannot rotate the
subscriber configuration, create a replacement endpoint instead.

## `backfillOAuthClientRevokedAt`

Revoked OAuth client registrations are retained for 90 days before daily
cleanup. Older rows do not record their revocation time and therefore remain
untouched until you initialize their retention clock:

```sh
vp exec convex run auth/migrations:runBackfillOAuthClientRevokedAt '{}'
```

The migration is idempotent. It stamps legacy revoked rows with the migration
time, ensuring an upgrade cannot immediately delete historical registrations.
