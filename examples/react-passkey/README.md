# react-passkey example

This demo shows:

- The core component.
- The passkey component, through the `UsernamePasskey` provider.

The flow is identifier-first. The user enters a username. When the
username exists, the app asks for a passkey of that account. When the
username is free, the app creates the account and immediately asks the
user to register a passkey. There is no password and no recovery flow.

The example has no frontend yet; it contains only the Convex backend.

## Generate code / run

Run the example from its own directory.

```bash
cd examples/react-passkey
npx convex dev --once    # provisions a deployment, generates convex/_generated
npx @convex-dev/auth     # sets AUTH_PRIVATE_KEY + AUTH_JWKS on the deployment
```

## Test usage

The tests defined in the example are run along with `pnpm test` in the repo root.
