import { components, internal } from "./_generated/api";
import { convexAuth } from "@convex-dev/auth/server";
import { usernamePassword } from "@convex-dev/auth/schemes/username-password/server";

const auth = convexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const {
  signUpWithUsernamePassword,
  signInWithUsernamePassword,
  changePassword,
} = usernamePassword(auth, {
  component: components.authPassword,
  usernameComponent: components.authUsername,
}).attachUserCallbacks({ createUser: internal.users.createUser });
