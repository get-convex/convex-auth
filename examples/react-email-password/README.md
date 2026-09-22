# react-email-password example

This demo shows:

- The core component.
- The password component.
- The email component, with the `EmailPassword` provider: sign-up with email
  validation, sign-in, change password, change email, and password recovery.

## Generate code / run

Run the example from its own directory.

```bash
cd examples/react-email-password
npx convex dev --once    # provisions a deployment, generates convex/_generated
npx @convex-dev/auth     # sets AUTH_PRIVATE_KEY + AUTH_JWKS on the deployment
npx convex env set RESEND_API_KEY re_...   # your Resend API key
npm run dev              # start the Vite frontend
```

Optional environment variables on the deployment:

- `SITE_URL` — the frontend origin the emailed links point at. Defaults to
  `http://localhost:5173` (the Vite dev server).
