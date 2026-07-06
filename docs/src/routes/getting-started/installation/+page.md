---
title: Installation
description: Set up convex-auth in your project.
---

<script>
  import Tabs from '$lib/components/docs/Tabs.svelte';
  import TabItem from '$lib/components/docs/TabItem.svelte';
  import Card from '$lib/components/docs/Card.svelte';
  import CardGrid from '$lib/components/docs/CardGrid.svelte';
</script>

<svelte:head>

  <title>Installation - convex-auth</title>
</svelte:head>

# Installation

## Install

<Tabs syncKey="pkg">
  <TabItem label="npm">

```bash
npm install @robelest/convex-auth
npx convex dev
npx @robelest/convex-auth
```

To skip the interactive prompt:

```bash
npx @robelest/convex-auth --app-url "http://localhost:5173"
```

  </TabItem>
  <TabItem label="pnpm">

```bash
pnpm add @robelest/convex-auth
pnpx convex dev
pnpx @robelest/convex-auth
```

To skip the interactive prompt:

```bash
pnpx @robelest/convex-auth --app-url "http://localhost:5173"
```

  </TabItem>
  <TabItem label="yarn">

```bash
yarn add @robelest/convex-auth
yarn dlx convex dev
yarn dlx @robelest/convex-auth
```

To skip the interactive prompt:

```bash
yarn dlx @robelest/convex-auth --app-url "http://localhost:5173"
```

  </TabItem>
</Tabs>

## Quick Setup (CLI)

The setup flow is:

1. install `@robelest/convex-auth`
2. start a Convex deployment with `convex dev`
3. run the auth setup wizard

The wizard handles everything:

- key generation
- `convex.config.ts`
- `auth.ts` — provider config + sign-in actions
- `auth/core.ts` — lightweight context for queries and mutations
- `auth.config.ts` — native Convex JWT trust config
- `http.ts`

## API layers

<CardGrid>
  <Card title="Client auth flow">
    Frontends use <code>client({'{'} convex, api: api.auth {'}'})</code>. The public client contract is
    <code>signIn</code> + <code>signOut</code>; <code>store</code> is internal runtime plumbing.
  </Card>
  <Card title="Server helpers">
    `auth.user.*`, `auth.connection.*`, and `auth.connection.scim.*` are server-side helpers for
    Convex code. They are not automatically public RPC.
  </Card>
  <Card title="Optional group SSO RPC">
    If your app wants client-callable group SSO admin APIs, expose app-owned
    wrappers such as <code>convex/auth/group.ts</code>.
  </Card>
</CardGrid>

### 1. Register the component

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import auth from "@robelest/convex-auth/convex.config";
import { authEnv } from "@robelest/convex-auth/server";

const app = defineApp({ env: authEnv });
app.use(auth);
export default app;
```

### 2. Configure providers

```ts
// convex/auth.ts
import { defineAuth } from "@robelest/convex-auth/server";
import { components } from "./_generated/api";
import { env } from "./_generated/server";
import { github } from "@robelest/convex-auth/providers/github";

const auth = defineAuth(components.auth, {
  providers: [
    github({
      clientId: env.AUTH_GITHUB_ID!,
      clientSecret: env.AUTH_GITHUB_SECRET!,
    }),
  ],
});

export { auth };
export const { signIn, signOut, store } = auth;
```

`store` and `http` stay exported so the auth runtime can cross the Convex
component boundary without storing env-backed provider secrets in component
tables. Frontend apps should pass only `api.auth` into the client SDK.

### 3. Create the auth context

```ts
// convex/auth/core.ts
import { createAuthContext } from "@robelest/convex-auth/core";
import { components } from "../_generated/api";

export const auth = createAuthContext(components.auth);
```

Queries and mutations import `auth` from `./auth/core` — this keeps provider
and crypto code out of your query bundles entirely.

### 4. Trust the Convex Auth JWT issuer

```ts
// convex/auth.config.ts
import { env } from "./_generated/server";

export default {
  providers: [
    {
      domain: `${env.CONVEX_SITE_URL}/auth`,
      applicationID: "convex",
    },
  ],
};
```

`CONVEX_SITE_URL` is provided automatically by Convex. This file is what makes
`ctx.auth.getUserIdentity()` work against tokens issued by Convex Auth.

### 5. Auth HTTP routes

Mount the app-side auth protocol alias from `convex/http.ts`. This keeps OAuth
secrets in deployment env vars while the component still owns auth storage and
state.

```ts
// convex/http.ts
import { auth } from "./auth";

export default auth.http();
```
