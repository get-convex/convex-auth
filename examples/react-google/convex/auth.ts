import { components, internal } from "./_generated/api";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupGoogle } from "@convex-dev/auth/methods/google/server";

const core = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const { startSignInWithGoogle, completeSignInWithGoogle } = setupGoogle(
  core,
  {
    component: components.authGoogle,
    allowedRedirectOrigins: ["http://localhost:5173"],
  },
).attachUserCallbacks({ createUser: internal.users.createUser });
