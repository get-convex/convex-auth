import { components, internal } from "./_generated/api";
import { convexAuth } from "@convex-dev/auth/server";
import { apple } from "@convex-dev/auth/schemes/apple/server";

const auth = convexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { startSignInWithApple, completeSignInWithApple } = apple(auth, {
  component: components.authApple,
  allowedRedirectOrigins: ["http://localhost:5173"],
}).attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.onSignIn,
});
