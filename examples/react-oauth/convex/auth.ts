import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup";
import { Oauth } from "@convex-dev/auth/providers/oauth/setup";

// The core owns sessions, accounts, and JWT minting. It calls back into our
// `createOrUpdateUser` on every sign-in from a provider. Each Oauth instance
// covers one IdP and exposes `signIn`, which records an authorization
// request and returns the provider authorization URL for the client to
// navigate to.
export const {
  signOut,
  refreshSession,
  providers: {
    google: { signIn: signInGoogle, redeem: redeemGoogle },
  },
} = setupCore({
  component: components.core,
  providers: [
    provider(Oauth("google"), {
      component: components.oauthGoogle,
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      scopes: ["openid", "email", "profile"],
      pkce: true,
      allowedRedirectOrigins: ["http://localhost:5173"],
    }),
  ],
}).attachUserCallback(internal.users.createOrUpdateUser);
