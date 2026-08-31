import { components, internal } from "./_generated/api";
import { mutation } from "./_generated/server";
import { setupCore } from "@convex-dev/auth/core/setup";
import { setupUsernamePassword } from "@convex-dev/auth/providers/password/setup";
import { v } from "convex/values";
import { mathFactor } from "./lib/mathFactor";

const core = setupCore({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = core;

export const {
  signUpWithPassword,
  signInWithPassword,
  continueSignInWithPassword,
} = setupUsernamePassword(core, {
  component: components.authPasswordProvider,
  usernameComponent: components.authUsername,
  // The app's closed requirement vocabulary. It threads through the stack:
  // the evaluating callback's hand-written validators (users.ts) must mirror
  // it (checked at compile time by `attachUserCallbacks` and at runtime by
  // the validators derived from it), and the generated client types carry
  // the closed requirement union.
  //
  // The spec is only obtainable from the capability's setup: registering the
  // kind proves the thing that satisfies it is installed.
  signInRequirements: [mathFactor.requirement],
}).attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.evaluateSignIn,
});

// The math factor's own endpoints, mounted by the app. This is the whole
// integration story for a verified requirement: the factor verifies
// server-side and records its fact through the core's app-only primitives
// (`recordAttemptFacts` / `penalizeAttempt`), the app's evaluator just
// checks the fact's presence, and the client drives these when the
// requirement shows up. A provider could equally expose endpoints like
// these from its own API (e.g. a password `confirm` for re-authentication).

export const getMathChallenge = mutation({
  args: { attemptToken: v.string() },
  returns: v.union(
    v.object({ status: v.literal("challenge"), question: v.string() }),
    v.object({ status: v.literal("expired") }),
  ),
  handler: (ctx, args) =>
    mathFactor.getChallenge(ctx, components.auth, args.attemptToken),
});

export const verifyMathAnswer = mutation({
  args: { attemptToken: v.string(), answer: v.number() },
  returns: v.object({
    status: v.union(
      v.literal("verified"),
      v.literal("incorrect"),
      v.literal("expired"),
    ),
  }),
  handler: (ctx, args) =>
    mathFactor.verify(ctx, components.auth, args.attemptToken, args.answer),
});
