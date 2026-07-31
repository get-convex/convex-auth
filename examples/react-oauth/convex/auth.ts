import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup";
import { OauthGoogle } from "@convex-dev/auth/providers/oauth/google";
import { OauthGithub } from "@convex-dev/auth/providers/oauth/github";

// The core owns sessions, accounts, and JWT minting. It calls back into our
// `createOrUpdateUser` on every sign-in. Each OAuth provider is a built-in
// config (endpoints, scopes, profile mapping are internal) wired to its own
// oauth component mount; it exposes `startSignIn*`/`completeSignIn*` for the
// client.

export const {
  signOut,
  refreshSession,
  providers: {
    google: { startSignInGoogle, completeSignInGoogle },
    github: { startSignInGithub, completeSignInGithub },
  },
} = setupCore({
  component: components.core,
  providers: [
    provider(OauthGoogle, {
      component: components.oauthGoogle,
      httpPrefix: "/oauth/google",
      allowedRedirectOrigins: ["http://localhost:5173"],
    }),
    provider(OauthGithub, {
      component: components.oauthGithub,
      httpPrefix: "/oauth/github",
      allowedRedirectOrigins: ["http://localhost:5173"],
    }),
  ],
}).attachUserCallback(internal.users.createOrUpdateUser);
