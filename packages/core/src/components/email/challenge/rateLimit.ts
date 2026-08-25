import { Infer, v } from "convex/values";
import { mutation } from "../_generated/server.ts";
import { rateLimiter, getClientIp } from "../helpers.ts";
import { normalizeEmail } from "../validation.ts";

const checkStartResult = v.union(
  v.object({ ok: v.literal(true) }),
  v.object({ ok: v.literal(false), retryAfterMs: v.number() }),
);
type CheckStartResult = Infer<typeof checkStartResult>;

/**
 * Tell whether a `start` mutation would be rate limited, without consuming
 * the limits.
 *
 * Callers that must do other work before `start` (for example, create the
 * user) call this first and stop early on a limit, so the other work is not
 * committed when the flow cannot start. The check and the later consumption
 * run in one transaction when both happen in one mutation, so a passing
 * check cannot turn into a failing consumption.
 */
export const checkStart = mutation({
  args: { email: v.string() },
  returns: checkStartResult,
  handler: async (ctx, { email }): Promise<CheckStartResult> => {
    const key = normalizeEmail(email);
    const ip = await getClientIp(ctx);
    const perEmail = await rateLimiter.check(ctx, "startChallengePerEmail", {
      key,
    });
    const perIp = await rateLimiter.check(ctx, "startChallengePerIp", {
      key: ip,
    });
    if (!perEmail.ok || !perIp.ok) {
      return {
        ok: false,
        retryAfterMs: Math.max(
          perEmail.ok ? 0 : perEmail.retryAfter,
          perIp.ok ? 0 : perIp.retryAfter,
        ),
      };
    }
    return { ok: true };
  },
});
