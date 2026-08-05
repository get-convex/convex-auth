/**
 * App-side sensitive operations — the point of this fixture is the GUARD.
 *
 * Each handler's first line should be a one-liner freshness guard; the
 * business logic after it is deliberately boring. Different operations can
 * demand different windows.
 */
import { v } from "convex/values";
import { action, mutation } from "./_generated/server";
import { todo } from "./authTypes";

/** Show the account's API secret — sensitive, but not destructive. */
export const revealApiSecret = action({
  args: {},
  returns: v.object({ secret: v.string() }),
  handler: async (_ctx) => {
    // TODO(auth-v2): the first line of a sensitive handler should be a
    // one-liner guard, e.g.:
    //
    //   await requireRecentAuth(ctx, { within: 5 * 60_000 });
    //
    // which throws ConvexError({ code: "REAUTH_REQUIRED", methods:
    // ["password"], maxAgeMs }) when the current session's last
    // verification is older than the window. The error names the methods
    // that can satisfy the step-up; the client catches it, re-auths, and
    // retries. Then: return the secret.
    return todo("revealApiSecret");
  },
});

/** Destructive: delete the account. Demands a TIGHTER freshness window. */
export const deleteAccount = mutation({
  args: { confirm: v.literal("DELETE") },
  returns: v.null(),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2): same guard as revealApiSecret but with a TIGHTER
    // window — destructive operations can demand fresher proof:
    //
    //   await requireRecentAuth(ctx, { within: 60_000 });
    //
    // Then: delete the user document and revoke ALL of the user's
    // sessions. A lifecycle hook should send the farewell email.
    return todo("deleteAccount");
  },
});
