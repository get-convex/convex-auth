import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { requirementValidators } from "@convex-dev/auth/lib/requirements";
import { mathFactor } from "./lib/mathFactor";

/**
 * Create the user row for a new password account and return its id. The
 * provider supplies the username it just registered in `profile`.
 *
 * Creation is eager: this runs even when the sign-in then parks as
 * incomplete (the math factor below) — only the session is withheld.
 */
export const createUser = internalMutation({
  args: {
    provider: v.literal("password"),
    providerAccountId: v.string(),
    profile: v.object({ username: v.string() }),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", { username: args.profile.username });
  },
});

// The evaluator's `facts` arg and `returns` validators, derived from the
// same specs registered on `setupUsernamePassword` (auth.ts). Deriving them
// here — the specs live in lib/mathFactor.ts — keeps this module free of
// any import from auth.ts, and keeps declaration and enforcement from
// drifting: a verdict emitting an unregistered kind fails validation (and,
// via `attachUserCallbacks`, the build).
const { vFacts, vVerdict } = requirementValidators([mathFactor.requirement]);

/**
 * The app's sign-in *evaluator*: it runs on every sign-in round — sign-up,
 * sign-in, and each continuation — blind to which round it is, and judges
 * only what is in front of it.
 *
 * The math factor gate is a pure presence check on the trusted facts bag:
 * the callback never evaluates the factor itself. Verification happens
 * out-of-band in the factor's own endpoints (see auth.ts), which record the
 * `mathVerified` fact on the attempt through the core's server-only
 * primitive; the next round sees it here and accepts the sign-in.
 */
export const evaluateSignIn = internalMutation({
  args: {
    provider: v.literal("password"),
    providerAccountId: v.string(),
    profile: v.object({ username: v.string() }),
    userId: v.id("users"),
    // The accumulated trusted facts (empty on a fresh sign-in; a fresh
    // sign-in re-proves its factors).
    facts: vFacts,
  },
  returns: vVerdict,
  handler: async (_ctx, args) => {
    if (args.facts.mathVerified === undefined) {
      return {
        status: "requirements-needed" as const,
        requirements: [{ kind: "mathFactor:problem" as const, data: {} }],
      };
    }
    // Nothing outstanding: the sign-in completes and a session is minted.
    return null;
  },
});
