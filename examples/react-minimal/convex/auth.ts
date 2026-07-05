import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup.js";
import { setupOAuth } from "@convex-dev/auth/oauth/setup.js";

// The core owns sessions, accounts, and JWT minting. It calls back into our
// `upsertFromAuth` on every sign-in; this example owns no users table and just
// echoes the account id back as the app user id.
const core = setupCore({
  component: components.core,
  createOrUpdateUser: internal.users.upsertFromAuth,
});

export const { signOut, refreshSession } = core;

// OAuth sign-in. The mounted provider components' own HTTP routes take the
// browser to the provider and back; the app's only endpoint in the flow is
// this mutation, which exchanges the one-time code from the callback redirect
// for a session.
const oauth = setupOAuth({
  providers: {
    google: components.googleOAuth,
    github: components.githubOAuth,
  },
  completeSignIn: core.completeSignIn,
});

export const { redeemOAuthCode } = oauth;
