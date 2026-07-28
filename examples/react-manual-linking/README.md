# react-manual-linking example

A variant of the `react-minimal` example that demonstrates manual account
linking: a user signs in anonymously and later links a username and password
to the same account so they can sign back in. It mounts the anonymous and
username/password providers alongside the core component.

The auth system owns sessions, providers, accounts, and JWT minting;
`convex/users.ts` owns the app side (the `upsertFromAuth` callback and a
`loggedInUser` query). Providers from the auth system expose sign in methods.

## Generate code / run

Run the example from its own directory.

```bash
cd examples/react-manual-linking
npx convex dev --once    # provisions a deployment, generates convex/_generated
npx @convex-dev/auth     # sets AUTH_PRIVATE_KEY + AUTH_JWKS on the deployment
```

## Test usage

The tests defined in the example are run along with `pnpm test` in the repo root.
