import { components, internal } from "./_generated/api";
import { convexAuth } from "@convex-dev/auth/server";
import { anonymous } from "@convex-dev/auth/schemes/anonymous/server";
import { github } from "@convex-dev/auth/schemes/github/server";
import { usernamePassword } from "@convex-dev/auth/schemes/username-password/server";

// The auth owns sessions, accounts, and JWT minting. Each provider is wired to
// it with its own setup function, and only hands back its functions once the
// app attaches the callbacks that create its user rows. Each provider exposes
// the functions its client hooks call: `signInAnonymously` for the anonymous
// provider, `signUpWithUsernamePassword` / `signInWithUsernamePassword` for the password one.
// Under SSR those calls get proxied to Convex via the SSR host. The sign-in
// functions exposed here are wired up to be proxied in src/lib/serverAuth.ts.
const auth = convexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

// `onSignIn` is optional, and runs on every sign-in including the first. This
// app uses it to stamp the user's last sign-in.
export const { signInAnonymously } = anonymous(auth, {
  component: components.authAnonymous,
}).attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.onSignIn,
});

export const { signUpWithUsernamePassword, signInWithUsernamePassword } =
  usernamePassword(auth, {
    component: components.authPassword,
    usernameComponent: components.authUsername,
  }).attachUserCallbacks({
    createUser: internal.users.createUser,
    onSignIn: internal.users.onSignIn,
  });

export const { startSignInWithGithub, completeSignInWithGithub } = github(
  auth,
  {
    component: components.authGithub,
    allowedRedirectOrigins: ["http://localhost:3000"],
  },
).attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.onSignIn,
});
