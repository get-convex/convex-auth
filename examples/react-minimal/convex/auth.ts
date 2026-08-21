import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup";
import { setupAnonymous } from "@convex-dev/auth/providers/anonymous/setup";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

const anonymous = setupAnonymous(core, { component: components.authAnonymous });
anonymous.attachUserCallbacks({ createUser: internal.users.createUser });
export const { signInAnonymous } = anonymous.exports;
