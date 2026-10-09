import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/server";
import { setupGoogle } from "@convex-dev/auth/schemes/google/server";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const { startSignInGoogle, completeSignInGoogle } = setupGoogle(core, {
  component: components.authGoogle,
  allowedRedirectOrigins: ["http://localhost:5173"],
}).attachUserCallbacks({ createUser: internal.users.createUser });
