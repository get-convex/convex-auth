import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup";
import { UsernamePasskey } from "@convex-dev/auth/providers/passkey/setup";

export const {
  signOut,
  refreshSession,
  providers: {
    passkey: {
      startSignIn,
      finishSignUp,
      finishSignIn,
      changeUsername,
      startAddPasskey,
      finishAddPasskey,
      listPasskeys,
      startDeletePasskey,
      finishDeletePasskey,
    },
  },
} = setupCore({
  component: components.core,
  providers: [
    provider(UsernamePasskey, {
      component: components.authPasskey,
      usernameComponent: components.authUsername,
      // The values below are for local development. In production, set the
      // relying party ID to the registrable domain of the app (for
      // example, "example.com") and the origin to the full app origin (for
      // example, "https://app.example.com").
      rpId: "localhost",
      origin: "http://localhost:5173",
    }),
  ],
}).attachUserCallback(internal.users.createOrUpdateUser);
