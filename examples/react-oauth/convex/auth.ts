import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup";
import { Oauth } from "@convex-dev/auth/providers/oauth/setup";

// The core owns sessions, accounts, and JWT minting. It calls back into our
// `createOrUpdateUser` on every sign-in from a provider. The oauth provider
// exposes `signInOauth`, which records an authorization request and returns
// the provider authorization URL for the client to navigate to.
export const {
  signOut,
  refreshSession,
  providers: {
    oauth: { signInOauth },
  },
} = setupCore({
  component: components.core,
  providers: [
    provider(Oauth, {
      providers: {
        google: {
          component: components.oauthGoogle,
          clientId: process.env.AUTH_GOOGLE_CLIENT_ID ?? "",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          scopes: ["openid", "email", "profile"],
          pkce: true,
        },
      },
      allowedRedirectOrigins: ["http://localhost:5173"],
    }),
  ],
}).attachUserCallback(internal.users.createOrUpdateUser);
