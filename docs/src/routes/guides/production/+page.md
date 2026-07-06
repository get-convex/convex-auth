---
title: Production Deploy
description: Deploy convex-auth to production.
---

<script>
  import Tabs from '$lib/components/docs/Tabs.svelte';
  import TabItem from '$lib/components/docs/TabItem.svelte';
</script>

<svelte:head>

  <title>Production Deploy - convex-auth</title>
</svelte:head>

# Production Deploy

## Setup production keys

<Tabs syncKey="pkg">
  <TabItem label="npm">

`npx @robelest/convex-auth --prod --app-url "https://myapp.com"`

  </TabItem>
  <TabItem label="pnpm">

`pnpx @robelest/convex-auth --prod --app-url "https://myapp.com"`

  </TabItem>
  <TabItem label="yarn">

`yarn dlx @robelest/convex-auth --prod --app-url "https://myapp.com"`

  </TabItem>
</Tabs>

## Set provider secrets

<Tabs syncKey="pkg">
  <TabItem label="npm">

`npx convex env set --prod AUTH_GITHUB_ID "..."` then
`npx convex env set --prod AUTH_GITHUB_SECRET "..."`

  </TabItem>
  <TabItem label="pnpm">

`pnpx convex env set --prod AUTH_GITHUB_ID "..."` then
`pnpx convex env set --prod AUTH_GITHUB_SECRET "..."`

  </TabItem>
  <TabItem label="yarn">

`yarn dlx convex env set --prod AUTH_GITHUB_ID "..."` then
`yarn dlx convex env set --prod AUTH_GITHUB_SECRET "..."`

  </TabItem>
</Tabs>

## Deploy

<Tabs syncKey="pkg">
  <TabItem label="npm">

```bash
npx convex deploy --cmd 'npm run build'
```

  </TabItem>
  <TabItem label="pnpm">

```bash
pnpx convex deploy --cmd 'pnpm run build'
```

  </TabItem>
  <TabItem label="yarn">

```bash
yarn dlx convex deploy --cmd 'yarn build'
```

  </TabItem>
</Tabs>

## Checklist

- `APP_URL` is set to your production domain (not `localhost`)
- `JWT_PRIVATE_KEY`, `JWKS`, and `AUTH_SECRET_ENCRYPTION_KEY` are set (the CLI
  handles this)
- Provider secrets (`AUTH_*_ID`, `AUTH_*_SECRET`) are configured
- `CONVEX_SITE_URL` is auto-provided by Convex
- `convex/auth.config.ts` trusts `env.CONVEX_SITE_URL` with
  `applicationID: "convex"`
- OAuth callback URLs are registered with your providers pointing to
  `CONVEX_SITE_URL`

### Cross-platform `.well-known` files

Apps using passkeys, password managers, or native iOS/Android sign-in should
serve these from the frontend host. See the
[.well-known reference](/reference/well-known) and the
[native apps guide](/guides/native-apps).

- For native iOS passkeys: `IOS_APP_IDS` set, `apple-app-site-association`
  reachable at the RP ID host with no redirects, no `.json` extension
- For native Android passkeys: `ANDROID_APP_LINKS` set, `assetlinks.json`
  reachable at the RP ID host
- For password manager UX: `CHANGE_PASSWORD_URL` set (302 from
  `/.well-known/change-password`)
- For security disclosure: `SECURITY_CONTACT` set with unexpired
  `Expires:` (refreshes every `SECURITY_TXT_EXPIRES_DAYS`, default 365)

## Auth refresh and Convex logs

Convex Auth refreshes stored browser sessions when the Convex client asks for a
fresh access token. In logs this can show up as an `auth:signIn` action followed
by an `auth:store` mutation. That pair is expected on page load, token refresh,
and across multiple tabs or visitors.

Each refresh mutation can cause active Convex subscriptions to re-evaluate. If
your logs show a burst of many cached query evaluations after auth refresh, first
look for duplicate or unnecessary subscriptions in the app:

- avoid subscribing to the same query in both a page and child component;
- pass already-loaded data as props when possible;
- use `"skip"` for queries that are disabled by config or route state;
- only run auth-dependent queries on pages that actually need them.

Treat refresh as suspicious when a single tab with one auth client refreshes in a
tight loop. Common causes are duplicate auth clients, unavailable storage,
corrupted refresh-token storage, or proxy retry failures.
