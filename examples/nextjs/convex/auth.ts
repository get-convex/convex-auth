import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup";
import { userCallback } from "@convex-dev/auth/lib/types";
import { setupAnonymous } from "@convex-dev/auth/providers/anonymous/setup";
import { setupUsernamePassword } from "@convex-dev/auth/providers/password/setup";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

// Wrapped once, attached to both providers: the carrier type records what the
// mutations declare, and each provider checks it against what it sends.
const createUser = userCallback(internal.users.createUser);
const onSignIn = userCallback(internal.users.onSignIn);

export const { signInAnonymous } = setupAnonymous(core, {
  component: components.authAnonymous,
}).attachUserCallbacks2({ createUser, onSignIn });

export const { signUpWithPassword, signInWithPassword } =
  setupUsernamePassword(core, {
    component: components.authPasswordProvider,
    usernameComponent: components.authUsername,
  }).attachUserCallbacks2({ createUser, onSignIn });
