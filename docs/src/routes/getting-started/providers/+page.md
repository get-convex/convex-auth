---
title: Providers
description: Auth methods available in convex-auth.
---

<svelte:head>

  <title>Providers - convex-auth</title>
</svelte:head>

# Providers

## OAuth

convex-auth currently ships first-party OAuth wrappers for Google, GitHub,
Apple, and Microsoft. Each wrapper owns the provider defaults and automatically
derives the callback URL from `CONVEX_SITE_URL` unless you override it.
These examples assume `convex/convex.config.ts` uses `defineApp({ env:
authEnv })` and provider setup imports generated `env` from
`./_generated/server`.

```ts
import { defineAuth } from "@robelest/convex-auth/server";
import {
  anonymous,
  apple,
  credentials,
  custom,
  email,
  github,
  google,
  microsoft,
  passkey,
  password,
  phone,
  connection,
  totp,
} from "@robelest/convex-auth/providers";
import { components } from "./_generated/api";
import { env } from "./_generated/server";

defineAuth(components.auth, {
  providers: [
    github({
      clientId: env.AUTH_GITHUB_ID!,
      clientSecret: env.AUTH_GITHUB_SECRET!,
    }),
    google({
      clientId: env.AUTH_GOOGLE_ID!,
      clientSecret: env.AUTH_GOOGLE_SECRET!,
    }),
    microsoft({
      tenant: env.AUTH_MICROSOFT_TENANT_ID!,
      clientId: env.AUTH_MICROSOFT_ID!,
      clientSecret: env.AUTH_MICROSOFT_SECRET!,
    }),
  ],
});
```

GitHub includes a built-in profile fetch. Google, Apple, and Microsoft rely on
their ID token claims by default.

### Profile sync on re-auth

OAuth providers default to `updateProfileOnLogin: true` — on a returning
sign-in for the same `(provider, providerAccountId)`, the user's `name`,
`image`, and `email` are refreshed from the new provider profile. This
matches Auth.js / Clerk conventions.

Opt out per-provider if your app owns the canonical user profile:

```ts
google({
  clientId: env.AUTH_GOOGLE_ID!,
  clientSecret: env.AUTH_GOOGLE_SECRET!,
  updateProfileOnLogin: false, // keep user fields user-edited
});
```

The flag is available on `google`, `github`, `apple`, `microsoft`, and
`custom`. SSO connections have their own equivalent under
`policy.provisioning.user.updateProfileOnLogin`.

### Google

- Import: `@robelest/convex-auth/providers`
- Factory:
  `google({ clientId, clientSecret, redirectUri?, scopes?, accountLinking?, updateProfileOnLogin? })`
- Default scopes: `openid profile email`
- Required env: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`

```ts
import { google } from "@robelest/convex-auth/providers";

defineAuth(components.auth, {
  providers: [
    google({
      clientId: env.AUTH_GOOGLE_ID!,
      clientSecret: env.AUTH_GOOGLE_SECRET!,
    }),
  ],
});
```

Use `redirectUri` only when you need to override the default callback route.

### GitHub

- Import: `@robelest/convex-auth/providers`
- Factory:
  `github({ clientId, clientSecret, redirectUri?, scopes?, accountLinking?, updateProfileOnLogin? })`
- Default scopes: `user:email`
- Required env: `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`

```ts
import { github } from "@robelest/convex-auth/providers";

defineAuth(components.auth, {
  providers: [
    github({
      clientId: env.AUTH_GITHUB_ID!,
      clientSecret: env.AUTH_GITHUB_SECRET!,
    }),
  ],
});
```

The GitHub wrapper performs the profile and email fetch for you.

### Apple

- Import: `@robelest/convex-auth/providers`
- Factory:
  `apple({ clientId, teamId, keyId, privateKey, redirectUri?, scopes?, accountLinking?, updateProfileOnLogin? })`
- Default scopes: `name email`
- Required env: `AUTH_APPLE_ID`, `AUTH_APPLE_TEAM_ID`, `AUTH_APPLE_KEY_ID`,
  `AUTH_APPLE_PRIVATE_KEY`

```ts
import { apple } from "@robelest/convex-auth/providers";

defineAuth(components.auth, {
  providers: [
    apple({
      clientId: env.AUTH_APPLE_ID!,
      teamId: env.AUTH_APPLE_TEAM_ID!,
      keyId: env.AUTH_APPLE_KEY_ID!,
      privateKey: env.AUTH_APPLE_PRIVATE_KEY!,
    }),
  ],
});
```

Apple may only return name data during the initial consent flow, so plan to
persist any extra profile fields you care about on first sign-in.

### Microsoft

- Import: `@robelest/convex-auth/providers`
- Factory:
  `microsoft({ tenant, clientId, clientSecret?, redirectUri?, scopes?, accountLinking?, updateProfileOnLogin? })`
- Default scopes: `openid profile email`
- Required env: `AUTH_MICROSOFT_TENANT_ID`, `AUTH_MICROSOFT_ID`
- Optional env: `AUTH_MICROSOFT_SECRET`

```ts
import { microsoft } from "@robelest/convex-auth/providers";

defineAuth(components.auth, {
  providers: [
    microsoft({
      tenant: env.AUTH_MICROSOFT_TENANT_ID!,
      clientId: env.AUTH_MICROSOFT_ID!,
      clientSecret: env.AUTH_MICROSOFT_SECRET!,
    }),
  ],
});
```

The Microsoft wrapper validates the ID token and nonce internally.

### OAuth imports

- `@robelest/convex-auth/providers`

## Custom OAuth

```ts
defineAuth(components.auth, {
  providers: [
    custom({
      id: "discord",
      clientId: env.AUTH_DISCORD_ID!,
      clientSecret: env.AUTH_DISCORD_SECRET!,
      scopes: ["identify", "email"],
      authorization: {
        url: "https://discord.com/oauth2/authorize",
        pkce: "optional",
      },
      token: {
        url: "https://discord.com/api/oauth2/token",
        authMethod: "body",
      },
      profile: async ({ accessToken }) => {
        const res = await fetch("https://discord.com/api/users/@me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const user = await res.json();
        return {
          id: String(user.id),
          email: user.email,
          name: user.username,
        };
      },
    }),
  ],
});
```

Use `custom()` when the provider is OAuth-based but does not have a first-party
wrapper yet. The `profile()` callback receives a stable token object owned by
convex-auth so the public API does not depend on Arctic.

## Custom Credentials

`credentials()` is the low-level escape hatch for authentication that is not
OAuth-based. Provide an `authorize` callback that validates the submitted
credentials and returns the authenticated user; return `null` to reject the
attempt. The built-in `password()` provider is layered on top of this.

- Import: `@robelest/convex-auth/providers`
- Factory: `credentials({ id?, authorize, crypto?, extraProviders? })`
- Default `id`: `"credentials"`

```ts
import { credentials } from "@robelest/convex-auth/providers";

defineAuth(components.auth, {
  providers: [
    credentials({
      id: "api-token",
      authorize: async (params, ctx) => {
        const user = await lookupUserByToken(ctx, params.token as string);
        return user ? { userId: user._id } : null;
      },
    }),
  ],
});
```

`authorize` receives the raw `params` passed to `signIn` and the action `ctx`.
Return `{ userId }` (optionally `sessionId`) to complete sign-in, a deferred
`SignInFlowResult` for multi-step flows, or `null` to reject. Pass `crypto`
(`hashSecret`/`verifySecret`) for password-style secret verification, and
`extraProviders` to register additional providers alongside it.

## Password

```ts
defineAuth(components.auth, {
  providers: [password()],
});
```

The password provider supports five flows, all single-word camelCase. Pass
the flow name in `params.flow` when calling `signIn`:

| Flow     | Authenticated? | Required params                           | Notes                                                    |
| -------- | -------------- | ----------------------------------------- | -------------------------------------------------------- |
| `signUp` | No             | `email`, `password`                       | Creates a new account                                    |
| `signIn` | No             | `email`, `password`                       | Authenticate existing user                               |
| `reset`  | No             | `email`                                   | Sends an OTP via the configured `reset` email provider   |
| `verify` | No             | `email`, `code`, `newPassword?`           | Verifies an OTP. With `newPassword`, completes a `reset` |
| `change` | Yes            | `email`, `currentPassword`, `newPassword` | Authenticated change. Other sessions invalidated         |

`reset` and `verify` (with `newPassword`) require a `reset` email provider in
the config; `verify` (without `newPassword`) requires a `verify` email provider.
The OTP scope is enforced server-side — a `reset`-issued OTP refuses to verify
without `newPassword`, and a signup-issued OTP refuses with one.

```ts
// Forgot password
auth.signIn("password", { provider: "password", params: { email, flow: "reset" } });
auth.signIn("password", { params: { email, code, newPassword, flow: "verify" } });

// Change password (authenticated)
auth.signIn("password", { params: { email, currentPassword, newPassword, flow: "change" } });
```

To enable `reset` and post-signup email verification, pass an email provider:

```ts
import { password, email } from "@robelest/convex-auth/providers";

const emailProvider = email({ from: "noreply@example.com", send: ... });

password({ reset: emailProvider, verify: emailProvider });
```

## Magic Links (Email)

```ts
defineAuth(components.auth, {
  providers: [
    email({
      from: "My App <noreply@example.com>",
      send: async (ctx, { from, to, subject, html }) => {
        const resend = new Resend(env.RESEND_API_KEY);
        await resend.emails.send({ from, to, subject, html });
      },
    }),
  ],
});
```

## Passkeys / WebAuthn

```ts
defineAuth(components.auth, {
  providers: [passkey()],
});
```

## TOTP (Authenticator Apps)

```ts
defineAuth(components.auth, {
  providers: [totp({ issuer: "My App" })],
});
```

## Anonymous

```ts
defineAuth(components.auth, {
  providers: [anonymous()],
});
```

## Phone / SMS

```ts
defineAuth(components.auth, {
  providers: [
    phone({
      send: async ({ identifier, token }) => {
        // send SMS via Twilio, etc.
      },
    }),
  ],
});
```

## Group SSO

```ts
defineAuth(components.auth, {
  providers: [connection()],
});
```

Adding `connection()` enables the `auth.connection.*` namespace and registers OIDC,
SAML, and SCIM HTTP routes. See the [SSO overview](/connection/overview/) for details.
