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
npx convex env set SENDER_EMAIL auth@example.com
npm run dev              # start the Vite frontend
```

The example sends real email through [Resend](https://resend.com).
`SENDER_EMAIL` is the From address of the emails. It must be on a
[domain you verified with Resend](https://resend.com/docs/dashboard/domains/introduction).
To try the example without a domain, use `onboarding@resend.dev`, which only
delivers to the email address of your own Resend account.

To send through Convex's email service instead, skip the Resend variables and
set the URL of a development deployment of the service:

```bash
npx convex env set CONVEX_EMAIL_SERVICE_URL https://<auth-emails-dev>.convex.cloud
```

The service sends its own templates from a Convex address. It authenticates
this deployment with the token of `getServiceToken("ai-gateway")`, so the
deployment needs the AI gateway.

Optional environment variables on the deployment:

- `SENDER_NAME` — the From name of the emails with Resend, and the app name
  in the emails of Convex's email service. Defaults to `My App`.

- `SITE_URL` — the frontend origin the emailed links point at. Defaults to
  `http://localhost:5173` (the Vite dev server).
