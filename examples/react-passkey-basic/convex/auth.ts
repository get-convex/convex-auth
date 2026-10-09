import { components, internal } from "./_generated/api";
import { convexAuth } from "@convex-dev/auth/server";
import { usernamePasskey } from "@convex-dev/auth/schemes/username-passkey/server";

const auth = convexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const {
  startSignInWithUsernamePasskey,
  startAutofillSignInWithUsernamePasskey,
  finishSignUpWithUsernamePasskey,
  finishSignInWithUsernamePasskey,
} = usernamePasskey(auth, {
  component: components.authPasskey,
  usernameComponent: components.authUsername,
  // The relying party ID and the origin of the Vite dev server. A deployed
  // app uses its own domain here.
  rpId: "localhost",
  origin: "http://localhost:5173",
}).attachUserCallbacks({ createUser: internal.users.createUser });
