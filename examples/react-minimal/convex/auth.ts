import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup";
import { Anonymous } from "@convex-dev/auth/providers/anonymous/setup";

export const {
  signOut,
  refreshSession,
  providers: {
    anonymous: { signInAnonymous },
  },
} = setupCore({
  component: components.auth,
  providers: [
    provider(Anonymous, {
      component: components.authAnonymous,
    }),
  ],
}).attachUserCallback(internal.users.upsertFromAuth);
