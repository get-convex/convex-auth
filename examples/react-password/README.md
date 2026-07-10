# react-password example

An in-repo Convex backend that mounts the `@convex-dev/auth` core component
together with the `@convex-dev/auth-password` provider. It exists as an example
of wiring username/password auth into an application and for integration testing
the password provider end to end.

The core owns sessions, accounts, and JWT minting; the password provider stores
and verifies passwords keyed to an opaque user id. `convex/users.ts` owns the
app side (the `createOrUpdateUser` callback), and `convex/auth.ts` exposes the
`signUpWithPassword` / `signInWithPassword` actions.

## Generate code / run

Run the example from its own directory.

```bash
cd examples/react-password
npx convex dev --once    # provisions a deployment, generates convex/_generated
npx generate-auth-keys   # sets AUTH_PRIVATE_KEY + AUTH_JWKS on the deployment
```

## Test usage

The tests defined in the example are run along with `pnpm test` in the repo root.
