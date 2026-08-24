import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup";
import { setupGoogle } from "@convex-dev/auth/providers/oauth/google";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const { startSignInGoogle, completeSignInGoogle } = setupGoogle(core, {
  component: components.oauthGoogle,
  allowedRedirectOrigins: ["http://localhost:5173"],
}).attachUserCallbacks({ createUser: internal.users.createUser });
