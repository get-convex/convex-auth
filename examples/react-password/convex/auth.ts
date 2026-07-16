import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup";
import { UsernamePassword } from "@convex-dev/auth/providers/password/setup";

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
