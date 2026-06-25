import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * The app's user-creation callback. The core invokes it (via a function handle)
 * the first time a new account signs in.
 *
 * This minimal example owns no users table. Instead of storing a row, it simply
 * echoes the provider-scoped account id back as the app's user id. The core
 * treats that value as an opaque string: it goes into the `accounts`/`sessions`
 * tables and becomes the JWT `subject`, so `ctx.auth.getUserIdentity().subject`
 * ends up being the provider account id. The (provider, providerAccountId) pair
 * is stable, so the subject stays the same across logins.
 *
 * The `userId` arg is part of the core's callback contract (it's set when an
 * existing user links another identity). With no users table there's nothing to
 * link, so we just honor it when present.
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
