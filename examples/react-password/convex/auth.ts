import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/server";
import { setupUsernamePassword } from "@convex-dev/auth/schemes/username-password/server";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const { signUpWithPassword, signInWithPassword, changePassword } =
  setupUsernamePassword(core, {
    component: components.authPassword,
    usernameComponent: components.authUsername,
  }).attachUserCallbacks({ createUser: internal.users.createUser });
