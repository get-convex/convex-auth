/**
 * Shared, aspirational result types for Convex Auth v2 sign-in flows.
 *
 * Copied verbatim into every `flow-*` example (see examples/FLOWS.md).
 * Every sign-in-adjacent server function returns `vFlowResult`, so clients
 * drive all of their UI off a single discriminated union.
 */
import { Infer, v } from "convex/values";

/** Matches the existing client contract (`useAuthActions().setSession`). */
export const vTokenBundle = v.object({
  accessToken: v.string(),
  accessTokenExpiresAt: v.number(),
  refreshToken: v.string(),
  refreshTokenExpiresAt: v.number(),
  userId: v.string(),
});
export type TokenBundle = Infer<typeof vTokenBundle>;

/** Steps the server may require before a flow can complete. */
export const vNeedsStep = v.union(
  v.literal("verify-email"),
  v.literal("totp"),
  v.literal("confirm-link"),
  v.literal("onboarding"),
);

export const vFlowResult = v.union(
  // Signed in. Hand `tokens` to `useAuthActions().setSession`.
  v.object({
    status: v.literal("complete"),
    tokens: vTokenBundle,
  }),
  // The server requires another step before sign-in can complete. `flowId`
  // resumes the same flow across calls, page reloads, and redirects.
  v.object({
    status: v.literal("needs"),
    step: vNeedsStep,
    flowId: v.string(),
    // Step-specific context that is safe to show the user (e.g. a masked
    // email for confirm-link, a resend cooldown for verify-email).
    detail: v.optional(v.record(v.string(), v.any())),
  }),
  // Typed, developer-authored rejection that is safe to show the user.
  // `code` comes from the shared registry in examples/FLOWS.md.
  v.object({
    status: v.literal("error"),
    code: v.string(),
    message: v.string(),
  }),
);
export type FlowResult = Infer<typeof vFlowResult>;

/** Throw-helper for stub bodies. */
export function todo(what: string): never {
  throw new Error(`Not implemented (auth-v2 evaluation stub): ${what}`);
}
