import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup";
import { setupAnonymous } from "@convex-dev/auth/providers/anonymous/setup";
import { setupUsernamePassword } from "@convex-dev/auth/providers/password/setup";

// The core owns sessions, accounts, and JWT minting. Each provider is wired to
// it with its own setup function, and only hands back its functions once the
// app attaches the callbacks that create its user rows. Each provider exposes
// the functions its client hooks call: `signInAnonymous` for the anonymous
// provider, `signUpWithPassword` / `signInWithPassword` for the password one.
// Under SSR those calls get proxied to Convex via the SSR host. The sign-in
// functions exposed here are wired up to be proxied in src/lib/serverAuth.ts.
const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const { signInAnonymous } = setupAnonymous(core, {
  component: components.authAnonymous,
}).attachUserCallbacks({ onSignUp: internal.users.onSignUpAnonymous });

// `onSignIn` is optional. This app uses it to stamp the user's last sign-in.
export const { signUpWithPassword, signInWithPassword } = setupUsernamePassword(
  core,
  {
    component: components.authPasswordProvider,
    usernameComponent: components.authUsername,
  },
).attachUserCallbacks({
  onSignUp: internal.users.onSignUpPassword,
  onSignIn: internal.users.onSignInPassword,
});
