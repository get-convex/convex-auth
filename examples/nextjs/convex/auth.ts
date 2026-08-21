import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup";
import { setupAnonymous } from "@convex-dev/auth/providers/anonymous/setup";
import { setupUsernamePassword } from "@convex-dev/auth/providers/password/setup";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

// Attaching the callbacks is a statement of its own rather than part of the
// exports below: the attach call is generic (that is what lets one mutation
// serve both providers), and a generic call over `internal.*` can't produce
// an exported value without asking TypeScript to type this module's exports
// in terms of themselves (TS7022). The `functions` property is not generic,
// so exporting from it is fine.
const anonymous = setupAnonymous(core, { component: components.authAnonymous });
anonymous.attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.onSignIn,
});
export const { signInAnonymous } = anonymous.exports;

const password = setupUsernamePassword(core, {
  component: components.authPasswordProvider,
  usernameComponent: components.authUsername,
});
password.attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.onSignIn,
});
export const { signUpWithPassword, signInWithPassword } = password.exports;
