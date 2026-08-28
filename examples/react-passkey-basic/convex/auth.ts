import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup";
import { setupUsernamePasskey } from "@convex-dev/auth/providers/passkey/setup";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const { startSignIn, startAutofillSignIn, finishSignUp, finishSignIn } =
  setupUsernamePasskey(core, {
    component: components.authPasskey,
    usernameComponent: components.authUsername,
    // The relying party ID and the origin of the Vite dev server. A deployed
    // app uses its own domain here.
    rpId: "localhost",
    origin: "http://localhost:5173",
  }).attachUserCallbacks({ createUser: internal.users.createUser });
