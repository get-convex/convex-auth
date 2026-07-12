# react-oauth example

An in-repo Convex backend that mounts the `@convex-dev/auth` core component
together with its oauth provider. It exists as an example of wiring oauth
into an application and for integration testing the oauth provider end to end.

## Generate code / run

Run the example from its own directory.

```bash
cd examples/react-oauth
npx convex dev --once    # provisions a deployment, generates convex/_generated
npx generate-auth-keys   # sets AUTH_PRIVATE_KEY + AUTH_JWKS on the deployment
```

## Test usage

The tests defined in the example are run along with `pnpm test` in the repo root.
