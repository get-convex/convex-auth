# react-minimal example

An in-repo Convex backend that mounts the `@convex-dev/auth` **core** component.
It exists so the component's generated code can be regenerated against a real
deployment, and as the home for the smallest end-to-end wiring.

The core owns sessions, accounts, and JWT minting; `convex/users.ts` owns the
app side (the `upsertFromAuth` callback and a `loggedInUser` query). A sign-in
path is added when a provider is wired in.

## Generate code / run

```bash
cd examples/react-minimal
npx convex dev --once    # provisions a deployment, generates convex/_generated
npx generate-auth-keys   # sets AUTH_PRIVATE_KEY + AUTH_JWKS on the deployment
```

`convex/_generated/` is produced by `convex dev` and is not committed here.
