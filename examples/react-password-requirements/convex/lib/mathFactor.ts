/**
 * A fake second factor packaged as a pluggable capability (a stand-in for a
 * real TOTP or passkey verifier). It owns everything about itself:
 *
 *  - its table (`tables`, which the app spreads into its schema),
 *  - challenge issuance and verification (`getChallenge` / `verify`, which
 *    the app mounts as public endpoints — see auth.ts),
 *  - and its requirement spec (`requirement`).
 *
 * The spec is only obtainable by calling {@link setupMathFactor}, so an app
 * that registers `mathFactor:problem` in its sign-in requirements
 * necessarily holds the setup value that mounts the table and the endpoints
 * — "requirable ⟹ available" by construction.
 *
 * The factor is verified out-of-band from the sign-in flow: the app's
 * `onSignIn` evaluator only ever emits the requirement (when the
 * `mathVerified` fact is absent) and never evaluates anything. The client
 * drives this factor's own endpoints — fetch the challenge, submit the
 * answer — and on success `verify` records the fact through the core's
 * `recordAttemptFacts` primitive, which only server code can reach. The
 * next sign-in round sees the fact and stops demanding the requirement.
 * Failed answers are metered against the attempt's continuation cap via
 * `penalizeAttempt`, so the endpoint isn't a free guessing oracle.
 */
import {
  type DataModelFromSchemaDefinition,
  defineSchema,
  defineTable,
  type GenericMutationCtx,
} from "convex/server";
import { v } from "convex/values";
import { requirement } from "@convex-dev/auth/lib/requirements";
import type { ComponentApi } from "@convex-dev/auth/core/setup";

const tables = {
  // The outstanding challenge per user. Created when the client first asks
  // for it, reused while unanswered, deleted when answered correctly (at
  // which point the recorded `mathVerified` fact takes over as the proof).
  mathChallenges: defineTable({
    userId: v.string(),
    question: v.string(),
    answer: v.number(),
  }).index("by_userId", ["userId"]),
};

// Only for typing the endpoint handlers' ctx against the factor's own
// table; the app mounts `tables` into its real schema, whose ctx is
// assignable to this one.
const _ownSchema = defineSchema(tables);
type MathFactorCtx = GenericMutationCtx<
  DataModelFromSchemaDefinition<typeof _ownSchema>
>;

export type MathFactor = ReturnType<typeof setupMathFactor>;

/** The app's one instance, consumed by schema.ts (tables), users.ts (the
 * requirement it emits), and auth.ts (the spec + mounted endpoints). A real
 * capability would be a package and the app would instantiate it in its own
 * module instead. */
export const mathFactor = setupMathFactor();

export function setupMathFactor(options?: { maxOperand?: number }) {
  const maxOperand = options?.maxOperand ?? 9;

  /** The live challenge for a user, creating one on first ask. */
  async function challengeFor(ctx: MathFactorCtx, userId: string) {
    const existing = await ctx.db
      .query("mathChallenges")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (existing !== null) return existing;
    const a = 1 + Math.floor(Math.random() * maxOperand);
    const b = 1 + Math.floor(Math.random() * maxOperand);
    const id = await ctx.db.insert("mathChallenges", {
      userId,
      question: `${a} + ${b}`,
      answer: a + b,
    });
    return (await ctx.db.get("mathChallenges", id))!;
  }

  /** Resolve the attempt's subject; the factor needs an anchored user. */
  async function subjectUserId(
    ctx: MathFactorCtx,
    core: ComponentApi,
    attemptToken: string,
  ): Promise<string | null> {
    const context = await ctx.runQuery(core.public.getAttemptContext, {
      attemptToken,
    });
    return context?.userId ?? null;
  }

  return {
    requirement: requirement("mathFactor:problem", {
      // The requirement itself carries no payload: the client fetches the
      // challenge from the factor's own endpoint, and the answer travels to
      // the endpoint too — never through the sign-in flow.
      data: v.object({}),
      facts: { mathVerified: v.object({ verifiedAt: v.number() }) },
    }),
    tables,
    /**
     * Handler for the app's challenge endpoint: the caller presents the
     * attempt token, and the factor issues (or repeats) the challenge for
     * the user that attempt is anchored to.
     */
    async getChallenge(
      ctx: MathFactorCtx,
      core: ComponentApi,
      attemptToken: string,
    ): Promise<
      { status: "challenge"; question: string } | { status: "expired" }
    > {
      const userId = await subjectUserId(ctx, core, attemptToken);
      if (userId === null) return { status: "expired" };
      const challenge = await challengeFor(ctx, userId);
      return { status: "challenge", question: challenge.question };
    },
    /**
     * Handler for the app's verification endpoint. A correct answer
     * consumes the challenge and records the `mathVerified` fact on the
     * attempt (the sign-in's next round sees it and stops demanding the
     * requirement); a wrong answer is metered against the attempt's
     * continuation cap.
     */
    async verify(
      ctx: MathFactorCtx,
      core: ComponentApi,
      attemptToken: string,
      answer: number,
    ): Promise<{ status: "verified" | "incorrect" | "expired" }> {
      const userId = await subjectUserId(ctx, core, attemptToken);
      if (userId === null) return { status: "expired" };
      const challenge = await ctx.db
        .query("mathChallenges")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();
      if (challenge !== null && answer === challenge.answer) {
        await ctx.db.delete("mathChallenges", challenge._id);
        const recorded = await ctx.runMutation(core.public.recordAttemptFacts, {
          attemptToken,
          facts: { mathVerified: { verifiedAt: Date.now() } },
        });
        return { status: recorded ? "verified" : "expired" };
      }
      // Wrong (or premature) answer: burn continuation budget so guessing
      // is bounded, and report whether the attempt survived.
      const alive = await ctx.runMutation(core.public.penalizeAttempt, {
        attemptToken,
      });
      return { status: alive ? "incorrect" : "expired" };
    },
  };
}
