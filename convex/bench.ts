/**
 * Benchmark-only Convex functions.
 *
 * These are deployed alongside the app for use by
 * benchmark `node.test.ts` files against the local Docker backend.
 * The goal is to measure *backend-side* wall time of sign-in flows — so we
 * can separate Convex runtime cost from HTTP / network RTT that a plain
 * client-side `Date.now()` around `ConvexHttpClient.action()` would
 * include.
 *
 * Each wrapper is a thin passthrough to `authSignIn` that records
 * `Date.now()` before and after. It pays one extra action-to-action
 * hop (`ctx.runAction`), so the returned `backendMs` slightly over-reports
 * actual sign-in action time — the test subtracts a baseline noop to
 * isolate the sign-in cost.
 *
 * **Not intended for production traffic.** The action surface exists for
 * benchmarking only.
 *
 * @internal
 */

import { makeFunctionReference } from "convex/server";
import type { Infer } from "convex/values";
import { v } from "convex/values";

import { action } from "./_generated/server";

const vAuthTokens = v.object({
  token: v.string(),
  refreshToken: v.string(),
});

const vSignInResult = v.union(
  v.object({
    kind: v.literal("signedIn"),
    session: v.union(vAuthTokens, v.null()),
  }),
  v.object({
    kind: v.literal("redirect"),
    redirect: v.string(),
    verifier: v.string(),
  }),
  v.object({ kind: v.literal("started") }),
  v.object({
    kind: v.literal("passkeyOptions"),
    options: v.record(v.string(), v.any()),
    verifier: v.string(),
  }),
  v.object({
    kind: v.literal("totpRequired"),
    verifier: v.string(),
  }),
  v.object({
    kind: v.literal("totpSetup"),
    totpSetup: v.object({
      uri: v.string(),
      secret: v.string(),
      totpId: v.string(),
    }),
    verifier: v.string(),
  }),
  v.object({
    kind: v.literal("deviceCode"),
    deviceCode: v.object({
      deviceCode: v.string(),
      userCode: v.string(),
      verificationUri: v.string(),
      verificationUriComplete: v.string(),
      expiresIn: v.number(),
      interval: v.number(),
    }),
  }),
);
type SignInResult = Infer<typeof vSignInResult>;

type SignInArgs =
  | { provider: "anonymous" }
  | {
      provider: "password";
      params: { email: string; password: string; flow: "signIn" | "signUp" };
    };
const authSignIn = makeFunctionReference<"action", SignInArgs, SignInResult>("auth:signIn");

/**
 * Issue a password sign-in and return the backend-observed wall time
 * alongside the result. For repeated calls under load, use `signInBatch`
 * (single action → N iterations → avoids N× network round-trips).
 */
export const passwordSignIn = action({
  args: { email: v.string(), password: v.string() },
  returns: v.object({
    result: vSignInResult,
    backendMs: v.number(),
  }),
  handler: async (ctx, { email, password }) => {
    const started = Date.now();
    const result = await ctx.runAction(authSignIn, {
      provider: "password",
      params: { email, password, flow: "signIn" },
    });
    const backendMs = Date.now() - started;
    return { result, backendMs };
  },
});

/**
 * Issue an anonymous sign-in and return the backend-observed wall time.
 * Used as a baseline — shows the non-crypto cost of the signIn envelope
 * (framework overhead + session insert + JWT sign).
 */
export const anonymousSignIn = action({
  args: {},
  returns: v.object({
    result: vSignInResult,
    backendMs: v.number(),
  }),
  handler: async (ctx) => {
    const started = Date.now();
    const result = await ctx.runAction(authSignIn, {
      provider: "anonymous",
    });
    const backendMs = Date.now() - started;
    return { result, backendMs };
  },
});

/**
 * Run N sequential password sign-ins inside a single backend action.
 * Returns per-iteration timings so the benchmark can compute p50 / p95 / max
 * without paying the client→backend HTTP RTT for every sample.
 *
 * The first iteration typically includes cold-path costs (RSA key import,
 * module evaluation) and will be flagged separately.
 */
export const passwordSignInBatch = action({
  args: {
    email: v.string(),
    password: v.string(),
    iterations: v.number(),
  },
  returns: v.object({
    backendMs: v.array(v.number()),
    totalMs: v.number(),
  }),
  handler: async (ctx, { email, password, iterations }) => {
    const batchStart = Date.now();
    const backendMs: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const start = Date.now();
      await ctx.runAction(authSignIn, {
        provider: "password",
        params: { email, password, flow: "signIn" },
      });
      backendMs.push(Date.now() - start);
    }
    return { backendMs, totalMs: Date.now() - batchStart };
  },
});

/**
 * Run N sequential anonymous sign-ins inside a single backend action.
 * Baseline companion to {@link passwordSignInBatch}.
 */
export const anonymousSignInBatch = action({
  args: { iterations: v.number() },
  returns: v.object({
    backendMs: v.array(v.number()),
    totalMs: v.number(),
  }),
  handler: async (ctx, { iterations }) => {
    const batchStart = Date.now();
    const backendMs: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const start = Date.now();
      await ctx.runAction(authSignIn, {
        provider: "anonymous",
      });
      backendMs.push(Date.now() - start);
    }
    return { backendMs, totalMs: Date.now() - batchStart };
  },
});
