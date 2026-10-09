import { components, internal } from "./_generated/api";
import { convexAuth } from "@convex-dev/auth/server";
import { google } from "@convex-dev/auth/schemes/google/server";

const auth = convexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { startSignInWithGoogle, completeSignInWithGoogle } = google(
  auth,
  {
    component: components.authGoogle,
    allowedRedirectOrigins: ["http://localhost:5173"],
  },
).attachUserCallbacks({ createUser: internal.users.createUser });
