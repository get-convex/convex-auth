import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup";
import { Anonymous } from "@convex-dev/auth/providers/anonymous/setup";

// The core owns sessions, accounts, and JWT minting. It calls back into our
// `createOrUpdateUser` on every sign-in. The anonymous provider exposes the
// `signInAnonymous` mutation the SSR sign-in route runs server-side.
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
      component: components.authAnonymous,
    }),
  ],
}).attachUserCallback(internal.users.createOrUpdateUser);
