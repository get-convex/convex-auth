import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup";
import { Anonymous } from "@convex-dev/auth/providers/anonymous/setup";
import { UsernamePassword } from "@convex-dev/auth/providers/password/setup";

// The core owns sessions, accounts, and JWT minting. It calls back into our
// `createOrUpdateUser` on every sign-in. Each provider exposes the functions its
// client hooks call: `signInAnonymous` for the anonymous provider,
// `signUpWithPassword` / `signInWithPassword` for the password one. Under SSR
// those calls go through the auth proxy, which needs each one listed in `signIn`
// in src/lib/serverAuth.ts.
export const {
  signOut,
  refreshSession,
  isAuthenticated,
  providers: {
    anonymous: { signInAnonymous },
    password: { signUpWithPassword, signInWithPassword },
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
}).attachUserCallback(internal.users.createOrUpdateUser);
