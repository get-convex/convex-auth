import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { vCreateOrUpdateUser } from "@convex-dev/auth/lib/types.js";

/**
 * The app's user create-or-update callback. The core invokes it (via a function
 * handle) on every sign-in — without a `userId` the first time an identity is
 * seen, and with the resolved `userId` thereafter.
 *
 * This minimal example owns no users table. Instead of storing a row, it
 * fabricates the app user id from the provider identity. The core treats that
 * value as an opaque string: it goes into the `accounts`/`sessions` tables and
 * becomes the JWT `subject`. The (provider, providerAccountId) pair is stable,
 * so the subject stays the same across logins — and prefixing with the
 * provider keeps ids from two providers from ever colliding.
 *
 * The `userId` arg is part of the core's callback contract (`null` on the
 * first sign-in, set on a returning one). With no users table there's nothing
 * to update, so we just honor it when present.
 */
export const upsertFromAuth = internalMutation({
  args: vCreateOrUpdateUser,
  returns: v.string(),
  handler: async (_ctx, args) =>
    args.userId ?? `${args.provider}:${args.providerAccountId}`,
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
