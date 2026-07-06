# Convex Auth MCP demo

This demo shows an AI agent operating on a **real user's workspace** through MCP,
authenticated with convex-auth acting as an OAuth 2.1 authorization server.

There is **no backend in this folder**. The MCP server and OAuth endpoints live in
the shared root `convex/` app (the same Linear-like workspace the `svelte`/`expo`/`cli`
demos use), so the AI acts on the user's actual groups, projects, issues, and comments —
scoped by the OAuth token. This folder is just a small client that mints an authorization
URL + PKCE pair for testing.

## Zero-config: just point a client at the URL

Once deployed (served by Convex static-hosting at the site URL), the server is a
standard remote MCP server with OAuth — you only configure the **MCP endpoint URL**
and the client does discovery → registration → login for you:

```
<your-deployment>.convex.site/mcp
```

e.g. `codex mcp login <that-url>`, `claude mcp add … <that-url>`, Cursor, or the MCP
Inspector. The client hits `/mcp`, gets `401` + `WWW-Authenticate`, reads
`/.well-known/oauth-protected-resource`, fetches the authorization-server metadata
(RFC 8414, served at every path convention clients probe), **dynamically registers**
itself (RFC 7591), opens the browser for PKCE login + consent, and connects with the
bearer token. No client id/secret to copy by hand. The manual PKCE script below is
just for poking at the flow directly.

## Where it lives in the root app

- `convex/auth.ts` — enables OAuth: `oauth: { pages: { login, consent } }`. The scopes the
  server advertises and clamps clients to are the app's `permissions` grants — there is no
  separate scope vocabulary.
- `convex/oauth.ts` — `registerClient` (mint a client) and `authorize` (the consent step
  the `/oauth/authorize` page submits; mints a single-use code).
- `convex/http.ts` — the resource server (the ~14 tools are declared inline via
  `auth.request.mcp(http, { ... })`):
  - `GET /.well-known/oauth-protected-resource`
  - `POST /mcp` (JSON-RPC `initialize` / `tools/list` / `tools/call`)
  - Auth endpoints under `/auth`: `/auth/oauth2/authorize`, `/auth/oauth2/token`.

Each tool calls an **existing** app function (`api.issues.*`, `api.projects.*`,
`api.comments.*`, `api.groups.*`). The OAuth access token is a valid Convex identity, so the
function resolves the user from `ctx.auth` and enforces role grants; the `/mcp` layer adds the
OAuth scope check — each tool requires one of the app's permission grants, compile-checked
against `definePermissions`.

## Tools

| Tool                 | Grant             | Calls                         |
| -------------------- | ----------------- | ----------------------------- |
| `list_groups`        | `projects.read`   | `api.groups.list`             |
| `get_workspace`      | `members.read`    | `api.groups.get`              |
| `list_projects`      | `projects.read`   | `api.projects.list`           |
| `list_issues`        | `projects.read`   | `api.issues.list`             |
| `get_issue`          | `projects.read`   | `api.issues.get`              |
| `list_invites`       | `members.read`    | `api.groups.listInvites`      |
| `create_project`     | `projects.create` | `api.projects.create`         |
| `create_issue`       | `issues.create`   | `api.issues.create`           |
| `update_issue`       | `issues.edit`     | `api.issues.update`           |
| `remove_issue`       | `issues.delete`   | `api.issues.remove`           |
| `create_comment`     | `comments.create` | `api.comments.create`         |
| `remove_comment`     | `comments.delete` | `api.comments.remove`         |
| `invite_member`      | `members.manage`  | `api.groups.inviteMember`     |
| `update_member_role` | `members.manage`  | `api.groups.updateMemberRole` |

## Flow

1. **Register a client.** Two ways:
   - **Automatic (Dynamic Client Registration, RFC 7591)** — a real MCP client discovers
     `registration_endpoint` in `/auth/.well-known/openid-configuration` and self-registers
     with no manual step. You can do the same by hand:

     ```bash
     curl -X POST https://<deployment>.convex.site/auth/oauth2/register \
       -H 'content-type: application/json' \
       -d '{"client_name":"Local MCP inspector",
            "redirect_uris":["http://localhost:8787/callback"],
            "scope":"projects.read issues.create"}'
     # → { "client_id": "oc_…", "client_secret": "cs_…", … }
     ```

     Requested scopes are clamped to the app's grants; clients are confidential
     (a secret is issued) and authorization-code only. Dynamic registration is always on
     when `oauth` is configured in `convex/auth.ts`.

   - **Manual** — in the svelte demo open **`/settings/developers`**, enter a name + redirect
     URI(s), and copy the returned `clientId` / `clientSecret` (shown only once). That page
     calls `api.oauth.registerClient`, which grants the client the workspace's full capabilities.

2. **Build an authorization URL** with PKCE (env: `MCP_AUTH_ISSUER`, `MCP_RESOURCE`,
   `MCP_CLIENT_ID`, `MCP_REDIRECT_URI`):

   ```bash
   vp exec tsx demos/mcp/src/client.ts
   ```

   Open the printed URL. `GET /auth/oauth2/authorize` hands off to the **`/oauth/authorize`**
   consent page in the svelte demo, which shows the requesting client + requested scopes and
   (if you aren't signed in yet) signs you in inline. On **Authorize** it calls
   `api.oauth.authorize` with the `client_id`, `redirect_uri`, requested `scope`, `state`, and
   PKCE `code_challenge`, then redirects back to your client with `?code=...&state=...`.

3. **Exchange the code** at `POST /auth/oauth2/token`
   (`grant_type=authorization_code`, `client_id`, `client_secret` for confidential clients,
   `redirect_uri`, `code`, `code_verifier`).

4. **Call the workspace** at `POST /mcp` with `Authorization: Bearer <access-token>`:

   ```http
   {"jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"list_issues","arguments":{"projectId":"..."}}}
   ```

   A token lacking a tool's grant (e.g. `issues.create`) is rejected at the `/mcp` layer; a
   user whose role lacks that grant is rejected by the app function itself.

## Deployment (same-origin)

The svelte demo is a static SPA served by **Convex static-hosting** at the deployment's site
URL. So the app, the auth server (`/auth/*`), the resource metadata, and `POST /mcp` all live
on one origin (`https://<deployment>.convex.site`) — the OAuth redirect to `/oauth/authorize`,
the consent page, the token endpoint, and the MCP endpoint are same-origin. Build + ship the
SPA with `pnpm --filter svelte deploy` (or `… upload`).

## Notes / follow-ups

Implemented: Dynamic Client Registration (RFC 7591), OAuth Authorization Server Metadata
(RFC 8414, served at all the path conventions clients probe), and the path-aware
protected-resource metadata — so a client configured with only the `/mcp` URL can
auto-discover and log in. Still intentionally **not** done: binding the access-token
audience to the MCP `resource` (the `aud` is `"convex"`; the resource server validates
signature + scopes rather than audience). See the
[MCP Authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).
