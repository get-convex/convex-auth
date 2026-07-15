# react-password example

This demo shows:

- The core component.
- The password component.

## Generate code / run

Run the example from its own directory.

```bash
cd examples/react-password
npx convex dev --once    # provisions a deployment, generates convex/_generated
npx generate-auth-keys   # sets AUTH_PRIVATE_KEY + AUTH_JWKS on the deployment
npm run dev              # start the Vite frontend
```

## Test usage

The tests defined in the example are run along with `pnpm test` in the repo root.
