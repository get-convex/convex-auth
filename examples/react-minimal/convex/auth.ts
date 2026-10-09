import { components, internal } from "./_generated/api";
import { convexAuth } from "@convex-dev/auth/server";
import { anonymous } from "@convex-dev/auth/schemes/anonymous/server";

const auth = convexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { signInAnonymously } = anonymous(auth, {
  component: components.authAnonymous,
}).attachUserCallbacks({ createUser: internal.users.createUser });
