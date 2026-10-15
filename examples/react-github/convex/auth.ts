import { components, internal } from "./_generated/api";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupGithub } from "@convex-dev/auth/methods/github/server";

const core = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const { startSignInWithGithub, completeSignInWithGithub } = setupGithub(
  core,
  {
    component: components.authGithub,
    allowedRedirectOrigins: ["http://localhost:5173"],
  },
).attachUserCallbacks({ createUser: internal.users.createUser });
