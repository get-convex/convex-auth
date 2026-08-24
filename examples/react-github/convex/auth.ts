import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup";
import { setupGithub } from "@convex-dev/auth/providers/oauth/github";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const { startSignInGithub, completeSignInGithub } = setupGithub(core, {
  component: components.oauthGithub,
  allowedRedirectOrigins: ["http://localhost:5173"],
}).attachUserCallbacks({ createUser: internal.users.createUser });
