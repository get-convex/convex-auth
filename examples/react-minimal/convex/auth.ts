import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup";
import { userCallback } from "@convex-dev/auth/lib/types";
import { setupAnonymous } from "@convex-dev/auth/providers/anonymous/setup";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const { signInAnonymous } = setupAnonymous(core, {
  component: components.authAnonymous,
}).attachUserCallbacks2({ createUser: userCallback(internal.users.createUser) });
