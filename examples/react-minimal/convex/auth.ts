import { components, internal } from "./_generated/api";
import { setupCore } from "@convex-dev/auth/core/setup.js";

// The core owns sessions, accounts, and JWT minting. It calls back into our
// `upsertFromAuth` on every sign-in; this example owns no users table and just
// echoes the account id back as the app user id.
const core = setupCore({
  component: components.core,
  createOrUpdateUser: internal.users.upsertFromAuth,
});

// A sign-in path (e.g. username/password) is wired in alongside a provider.
export const { signOut, refreshSession } = core;
