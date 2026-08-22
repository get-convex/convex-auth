# react-oauth example

This demo shows:

- The core component.
- The OAuth component.

## Generate code / run

Run the example from its own directory.

```bash
cd examples/react-oauth
npx convex dev --once    # provisions a deployment, generates convex/_generated
npx @convex-dev/auth     # sets AUTH_PRIVATE_KEY + AUTH_JWKS on the deployment
```

## Test usage

The tests defined in the example are run along with `pnpm test` in the repo root.
