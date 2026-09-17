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
npx convex env set RESEND_API_KEY re_...   # your Resend API key (required)
npm run dev              # start the Vite frontend
```

The example sends real email through [Resend](https://resend.com). Optional
environment variables on the deployment:

- `EMAIL_FROM` — the From address, e.g. `My App <auth@example.com>`. Defaults
  to `My App <onboarding@resend.dev>`, Resend's onboarding sender, which only
  delivers to the email address of your own Resend account. Set it to an
  address on a [domain you verified with Resend](https://resend.com/docs/dashboard/domains/introduction)
  to email anyone.
- `SITE_URL` — the frontend origin the emailed links point at. Defaults to
  `http://localhost:5173` (the Vite dev server).

## Validation links

A challenge link only works in the browser that started the flow: the
browser keeps a secret in local storage, and completion requires both the
secret and the code from the link.

## Test usage

The tests defined in the example are run along with `pnpm test` in the repo
root. Tests that need `ctx.meta` (everything that sends an email) are
skipped until convex-test supports it.
