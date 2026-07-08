import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup.js";
import { Anonymous } from "@convex-dev/auth/providers/anonymous/setup.js";

// The core owns sessions, accounts, and JWT minting. It calls back into our
// `upsertFromAuth` on every sign-in from a provider.
export const {
  signOut,
  refreshSession,
  providers: {
    anonymous: { signInAnonymous },
  },
} = setupCore({
  component: components.core,
  providers: [
    provider(Anonymous, {
      component: components.anonymous,
    }),
  ],
}).attachUserCallback(internal.users.upsertFromAuth);
