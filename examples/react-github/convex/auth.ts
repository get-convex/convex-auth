import { components, internal } from "./_generated/api";
import { convexAuth } from "@convex-dev/auth/server";
import { github } from "@convex-dev/auth/methods/github/server";

const auth = convexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { startSignInWithGithub, completeSignInWithGithub } = github(
  auth,
  {
    component: components.authGithub,
    allowedRedirectOrigins: ["http://localhost:5173"],
  },
).attachUserCallbacks({ createUser: internal.users.createUser });
