import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/server";
import { setupApple } from "@convex-dev/auth/schemes/apple/server";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const { startSignInApple, completeSignInApple } = setupApple(core, {
  component: components.authApple,
  allowedRedirectOrigins: ["http://localhost:5173"],
}).attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.onSignIn,
});
