import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup";
import { Oauth } from "@convex-dev/auth/providers/oauth/setup";

// The core owns sessions, accounts, and JWT minting. It calls back into our
// `createOrUpdateUser` on every sign-in from a provider. Each Oauth instance
// covers one IdP and exposes `signIn`, which records an authorization
// request and returns the provider authorization URL for the client to
// navigate to.
/** A GitHub `/user/emails` entry, the fields the profile mapping reads. */
type GithubEmail = { email: string; primary: boolean; verified: boolean };

export const {
  signOut,
  refreshSession,
  providers: {
    google: { signIn: signInGoogle, redeem: redeemGoogle },
    github: { signIn: signInGithub, redeem: redeemGithub },
  },
} = setupCore({
  component: components.core,
  providers: [
    provider(Oauth("google"), {
      component: components.oauthGoogle,
      // Must match the mount in convex.config.ts.
      httpPrefix: "/oauth/google",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      issuer: "https://accounts.google.com",
      scopes: ["openid", "email", "profile"],
      pkce: true,
      allowedRedirectOrigins: ["http://localhost:5173"],
    }),
    // GitHub is plain OAuth (no id_token), so identity comes from userinfo
    // endpoints and a profile mapping. No `pkce`: GitHub OAuth apps silently
    // ignore it.
    provider(Oauth("github"), {
      component: components.oauthGithub,
      // Must match the mount in convex.config.ts.
      httpPrefix: "/oauth/github",
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      scopes: ["read:user", "user:email"],
      userInfoEndpoints: {
        user: "https://api.github.com/user",
        emails: "https://api.github.com/user/emails",
      },
      profile: (_claims, userInfoResponses) => {
        const user = userInfoResponses?.user;
        const emails: GithubEmail[] = userInfoResponses?.emails ?? [];
        const best =
          emails.find((entry) => entry.primary && entry.verified) ??
          emails.find((entry) => entry.verified);
        return {
          id: String(user.id),
          email: best?.email ?? user.email,
          name: user.name ?? user.login,
        };
      },
      allowedRedirectOrigins: ["http://localhost:5173"],
    }),
  ],
}).attachUserCallback(internal.users.createOrUpdateUser);
