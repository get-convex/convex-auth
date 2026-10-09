import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/server";
import { setupAnonymous } from "@convex-dev/auth/schemes/anonymous/server";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const { signInAnonymous } = setupAnonymous(core, {
  component: components.authAnonymous,
}).attachUserCallbacks({ createUser: internal.users.createUser });
