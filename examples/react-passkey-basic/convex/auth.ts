import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup";
import { setupUsernamePasskey } from "@convex-dev/auth/providers/passkey/setup";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

const passkey = setupUsernamePasskey(core, {
  component: components.authPasskey,
  usernameComponent: components.authUsername,
  // The relying party ID and the origin of the Vite dev server. A deployed
  // app uses its own domain here.
  rpId: "localhost",
  origin: "http://localhost:5173",
}).attachUserCallbacks({ createUser: internal.users.createUser });

// The four sign-in mutations come first. Then come the functions that a
// signed-in user calls to list, to add, and to remove their passkeys.
export const {
  startSignIn,
  startAutofillSignIn,
  finishSignIn,
  finishSignUp,

  listPasskeys,

  startAddPasskey,
  verifyAddPasskey,
  finishAddPasskey,

  startRemovePasskey,
  finishRemovePasskey,
} = passkey;
