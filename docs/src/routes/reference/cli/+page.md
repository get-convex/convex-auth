---
title: CLI Reference
description: Command-line commands and options for the setup wizard.
---

<svelte:head>

  <title>CLI Reference - convex-auth</title>
</svelte:head>

# CLI Reference

## Commands

```bash
pnpx @robelest/convex-auth [command] [options]
```

The CLI defaults to `setup` when no command is given.

| Command  | Description                                                    |
| -------- | -------------------------------------------------------------- |
| `setup`  | Scaffold files and set environment variables (default).        |
| `doctor` | Verify env vars, files, and mounted auth endpoints.            |
| `urls`   | Print auth endpoint and provider callback URLs.                |
| `keys`   | Generate signing/encryption keys and set them on a deployment. |

## Setup wizard

```bash
pnpx @robelest/convex-auth [options]
```

The wizard runs 8 steps: configure `APP_URL`, generate signing and encryption
keys, modify `tsconfig.json`, create `convex.config`, create `auth.ts`, create
`http.ts`, create `auth/core.ts`, and create `auth.config.ts`.

The CLI expects typed deployment identifiers such as `dev:my-deployment`,
`prod:my-deployment`, or `preview:my-deployment` for Convex Cloud. Use `--url`
for explicit or self-hosted targets.

## Options

| Option                     | Description                                               |
| -------------------------- | --------------------------------------------------------- |
| `--app-url <url>`          | Value for `APP_URL`; avoids interactive prompt            |
| `--prod`                   | Target production deployment                              |
| `--preview-name <name>`    | Target preview deployment                                 |
| `--deployment-name <name>` | Target specific named deployment                          |
| `--url <url>`              | Target deployment by explicit URL or self-hosted endpoint |
| `--admin-key <key>`        | Use explicit admin key (typed for Convex Cloud)           |
| `--variables <json>`       | Additional variables for configuration                    |
| `--skip-git-check`         | Skip the "outside Git repo" warning                       |
| `--allow-dirty-git-state`  | Skip all source-control checks                            |

## Group Connection API

Group SSO RPC is app-owned. Create a single file like `convex/auth/group.ts` and
export only the helpers your app needs:

```ts
import { v } from "convex/values";
import { authMutation } from "./functions";
import { auth } from "../auth";
import { roles } from "../roles";

// Expose only the helpers your app needs — the same authMutation/authQuery
// pattern as the rest of your app. Authorize with auth.member.assert, then
// call the flat auth.connection.* facade.
export const createConnection = authMutation({
  args: {
    groupId: v.string(),
    protocol: v.union(v.literal("oidc"), v.literal("saml")),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await auth.member.assert(ctx, {
      userId: ctx.auth.userId,
      groupId: args.groupId,
      roleIds: [roles.orgAdmin.id],
    });
    return auth.connection.create(ctx, args);
  },
});

export const setScim = authMutation({
  args: { connectionId: v.string() },
  handler: async (ctx, args) => {
    const { groupId } = await auth.connection.get(ctx, { id: args.connectionId });
    await auth.member.assert(ctx, {
      userId: ctx.auth.userId,
      groupId,
      roleIds: [roles.orgAdmin.id],
    });
    return auth.connection.scim.upsert(ctx, args);
  },
});
```

Example:

```bash
pnpx @robelest/convex-auth --app-url "https://app.example.com"
```

Then call the exported functions with normal Convex hooks:

```ts
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";

const createConnection = useAction(api.auth.group.createConnection);
const setScim = useAction(api.auth.group.setScim);
```

Pass a concrete `groupId` when calling `createConnection(...)`.
