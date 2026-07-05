# react-minimal example

An in-repo Convex app plus a tiny Vite React frontend. It mounts the
`@convex-dev/auth` **core** component and two instances of the **oauth**
component (Google and GitHub). It exists so the components' generated code can
be regenerated against a real deployment, and as the home for the smallest
end-to-end wiring.

The core owns sessions, accounts, and JWT minting. Each oauth mount owns its
browser-facing flow on the deployment's `.convex.site` domain
(`/auth/<provider>/start` and `/auth/<provider>/callback`). The app side is
`convex/users.ts` (the `upsertFromAuth` callback and a `loggedInUser` query),
`convex/auth.ts` (component wiring, one `redeemOAuthCode` mutation), and a
frontend that hand-rolls the client plumbing a future React package will own:
starting flows (minting the browser-binding verifier), one-time-code
redemption, token storage, refresh.

## Set up

```bash
cd examples/react-minimal
npm install
npx convex dev --once      # provision a deployment; the first push fails until env vars are set
npx generate-auth-keys     # sets AUTH_PRIVATE_KEY + AUTH_JWKS
npx convex env set SITE_URL http://localhost:5173
npx convex env set GOOGLE_CLIENT_ID <id>           # console.cloud.google.com → Credentials → OAuth client
npx convex env set GOOGLE_CLIENT_SECRET <secret>
npx convex env set GITHUB_CLIENT_ID <id>           # github.com/settings/developers → OAuth Apps
npx convex env set GITHUB_CLIENT_SECRET <secret>
npx convex dev --once      # push succeeds, generates convex/_generated
```

Register each provider's redirect URI as

```
https://<deployment>.convex.site/auth/<provider>/callback
```

(for a local deployment, `http://127.0.0.1:<site port>/auth/<provider>/callback` —
both Google and GitHub accept localhost redirect URIs).

## Run

```bash
npx convex dev   # one terminal
npm run dev      # another; open http://localhost:5173
```

## Generated code

`convex/_generated/` is produced by `convex dev` and is not committed here.
The components' committed `src/components/*/_generated/` is regenerated from
this example too — `npx convex dev --once` refreshes it, or target one
component explicitly:

```bash
npx convex codegen --component-dir ../../src/components/oauth
```
