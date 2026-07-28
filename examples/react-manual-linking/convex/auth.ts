import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup";
import { Anonymous } from "@convex-dev/auth/providers/anonymous/setup";
import { UsernamePassword } from "@convex-dev/auth/providers/password/setup";

export const {
  signOut,
  refreshSession,
  providers: {
    anonymous: { signInAnonymous },
    password: { signInWithPassword, linkWithPassword },
  },
} = setupCore({
  component: components.core,
  providers: [
    provider(Anonymous, {
      component: components.authAnonymous,
    }),
    provider(UsernamePassword, {
      component: components.authPasswordProvider,
    }),
  ],
}).attachUserCallback(internal.users.upsertFromAuth);
