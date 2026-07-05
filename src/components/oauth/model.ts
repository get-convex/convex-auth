import { internalMutation, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { vAuthIntent, type AuthIntent } from "../../lib/oauth.js";
import { vAuthClaims, type AuthClaims } from "../../lib/types.js";

// How long a started flow stays redeemable. Generous enough for a user to
// pick an account / grant consent at the provider, short enough that stale
// states don't accumulate meaningfully.
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// How long the one-time sign-in code minted by the callback stays redeemable.
// The browser redeems it immediately after the redirect, so this only needs
// to absorb a slow page load.
const PENDING_TTL_MS = 2 * 60 * 1000; // 2 minutes

// How many expired rows each insert sweeps out. Expired rows are otherwise
// only deleted when presented again, which abandoned flows never do.
const CLEANUP_BATCH_SIZE = 20;

// The registered mutations below exist for the component's *actions* (the
// HTTP routes and `public.start`/`public.complete`), which can only reach the
// database through `ctx.runMutation`. `public.redeem` is itself a mutation,
// so it uses the plain `consumePendingByHash` helper directly.

/**
 * Delete a bounded batch of expired rows from one of the flow tables. Called
 * on every insert (rather than from a cron, which components can't declare):
 * each started flow sweeps out up to {@link CLEANUP_BATCH_SIZE} abandoned
 * ones, so the tables stay proportional to live traffic — a burst of
 * drive-by `/start` hits cleans more than it adds.
 */
async function deleteExpired(
  ctx: MutationCtx,
  table: "oauthStates" | "pendingSignIns",
): Promise<void> {
  const expired = await ctx.db
    .query(table)
    .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
    .take(CLEANUP_BATCH_SIZE);
  for (const row of expired) {
    await ctx.db.delete(table, row._id);
  }
}

/** Persist a started flow, keyed by its `state`. */
export const saveState = internalMutation({
  args: {
    state: v.string(),
    codeVerifier: v.optional(v.string()),
    challenge: v.optional(v.string()),
    intent: vAuthIntent,
    redirectTo: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteExpired(ctx, "oauthStates");
    await ctx.db.insert("oauthStates", {
      ...args,
      expiresAt: Date.now() + STATE_TTL_MS,
    });
    return null;
  },
});

const vStoredState = v.object({
  codeVerifier: v.optional(v.string()),
  challenge: v.optional(v.string()),
  intent: vAuthIntent,
  redirectTo: v.string(),
});

/**
 * Look up and delete the stored state in one step, so a `state` can never be
 * presented twice. Returns `null` for an unknown or expired state (the
 * expired row is still deleted).
 */
export const consumeState = internalMutation({
  args: { state: v.string() },
  returns: v.union(vStoredState, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .unique();
    if (!row) return null;
    await ctx.db.delete("oauthStates", row._id);
    if (row.expiresAt < Date.now()) return null;
    return {
      codeVerifier: row.codeVerifier,
      challenge: row.challenge,
      intent: row.intent,
      redirectTo: row.redirectTo,
    };
  },
});

/** Park verified claims under a one-time code's hash until redemption. */
export const savePending = internalMutation({
  args: {
    codeHash: v.string(),
    challenge: v.string(),
    claims: vAuthClaims,
    intent: vAuthIntent,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteExpired(ctx, "pendingSignIns");
    await ctx.db.insert("pendingSignIns", {
      ...args,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    return null;
  },
});

/**
 * Look up and delete a pending sign-in by its code hash in one step, so a
 * code can never be redeemed twice. `verifierHash` must match the challenge
 * captured when the flow started, proving the redeeming browser is the one
 * that began it. Returns `null` for an unknown or expired code, or a
 * mismatched verifier — and the row is consumed in every case, so a wrong
 * verifier burns the code rather than leaving it open to further guesses.
 */
export async function consumePendingByHash(
  ctx: MutationCtx,
  codeHash: string,
  verifierHash: string,
): Promise<{ claims: AuthClaims; intent: AuthIntent } | null> {
  const row = await ctx.db
    .query("pendingSignIns")
    .withIndex("by_code_hash", (q) => q.eq("codeHash", codeHash))
    .unique();
  if (!row) return null;
  await ctx.db.delete("pendingSignIns", row._id);
  if (row.expiresAt < Date.now()) return null;
  if (row.challenge !== verifierHash) return null;
  return { claims: row.claims, intent: row.intent };
}
