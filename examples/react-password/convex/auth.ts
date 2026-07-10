import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup";
import { UsernamePassword } from "@convex-dev/auth-password/setup";

// The core owns sessions, accounts, and JWT minting. It calls back into our
// `createOrUpdateUser` on every sign-in from a provider. The password provider
// exposes the sign up / sign in actions, keyed to an opaque app user id.
export const {
  signOut,
  refreshSession,
  providers: {
    password: { signUpWithPassword, signInWithPassword },
  },
} = setupCore({
  component: components.core,
  providers: [
    provider(UsernamePassword, {
      component: components.authPasswordProvider,
    }),
  ],
}).attachUserCallback(internal.users.createOrUpdateUser);
