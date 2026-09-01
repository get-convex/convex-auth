import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup";
import { setupApple } from "@convex-dev/auth/providers/oauth/apple";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const { startSignInApple, completeSignInApple } = setupApple(core, {
  component: components.oauthApple,
  allowedRedirectOrigins: ["http://localhost:5173"],
}).attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.onSignIn,
});
