import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * The app's user create-or-update callback. The core invokes it (via a function
 * handle) on every sign-in — without a `userId` the first time an identity is
 * seen, and with the resolved `userId` thereafter.
 *
 * This minimal example owns no users table. Instead of storing a row, it simply
 * echoes the provider-scoped account id back as the app's user id. The core
 * treats that value as an opaque string: it goes into the `accounts`/`sessions`
 * tables and becomes the JWT `subject`, so `ctx.auth.getUserIdentity().subject`
 * ends up being the provider account id. The (provider, providerAccountId) pair
 * is stable, so the subject stays the same across logins.
 *
 * The `userId` arg is part of the core's callback contract (it's set on a
 * returning sign-in, and when an existing user links another identity). With no
 * users table there's nothing to update, so we just honor it when present.
 */
export const upsertFromAuth = internalMutation({
  args: {
    provider: v.string(),
    providerAccountId: v.string(),
    profile: v.any(),
    userId: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (_ctx, args) => args.userId ?? args.providerAccountId,
});

/**
 * The signed-in identity, straight from the access token. There's no user row
 * to load — the subject is the provider account id the core minted into the
 * JWT. Returns null when no one is signed in.
 */
export const loggedInUser = query({
  args: {},
  handler: async (ctx) => ctx.auth.getUserIdentity(),
});
