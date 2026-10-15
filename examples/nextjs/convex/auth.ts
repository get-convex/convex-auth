import { components, internal } from "./_generated/api";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupAnonymous } from "@convex-dev/auth/methods/anonymous/server";
import { setupGithub } from "@convex-dev/auth/methods/github/server";
import { setupUsernamePassword } from "@convex-dev/auth/methods/username-password/server";

// The core owns sessions, accounts, and JWT minting. Each provider is wired to
// it with its own setup function, and only hands back its functions once the
// app attaches the callbacks that create its user rows. Each provider exposes
// the functions its client hooks call: `signInAnonymously` for the anonymous
// provider, `signUpWithUsernamePassword` / `signInWithUsernamePassword` for the password one.
// Under SSR those calls get proxied to Convex via the SSR host. The sign-in
// functions exposed here are wired up to be proxied in src/lib/serverAuth.ts.
const core = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

// `onSignIn` is optional, and runs on every sign-in including the first. This
// app uses it to stamp the user's last sign-in.
export const { signInAnonymously } = setupAnonymous(core, {
  component: components.authAnonymous,
}).attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.onSignIn,
});

export const { signUpWithUsernamePassword, signInWithUsernamePassword } =
  setupUsernamePassword(core, {
    component: components.authPassword,
    usernameComponent: components.authUsername,
  }).attachUserCallbacks({
    createUser: internal.users.createUser,
    onSignIn: internal.users.onSignIn,
  });

export const { startSignInWithGithub, completeSignInWithGithub } = setupGithub(
  core,
  {
    component: components.authGithub,
    allowedRedirectOrigins: ["http://localhost:3000"],
  },
).attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.onSignIn,
});
