/**
 * React client for the password provider, exported at
 * `@convex-dev/auth/providers/password/react`.
 *
 * A provider's job on the client is to run its own sign-in flow and hand the
 * resulting {@link TokenBundle} to the core client's `setSession` (see {@link
 * useAuthActions}).
 *
 * The password provider has two flows and provides a hook for each:
 *  1. signing in to an existing account ({@link useSignInWithPassword})
 *  2. signing up a new one ({@link useSignUpWithPassword})
 *
 * Each hook returns a function for sending up the credentials and a `pending`
 * value that is flipped to `true` while the credentials are being validated.
 *
 * When the backend registered sign-in requirements, a flow may resolve to an
 * *incomplete* result: the credentials verified, but the app requires more
 * (a second factor, say) before signing the user in. The result carries the
 * outstanding `requirements` for the UI to walk the user through and a
 * `continueWith` callback that resumes the flow — call it after the
 * requirement's verification endpoint has succeeded, and it resolves like
 * the original call: to a complete session, another incomplete result, or a
 * failure. Multi-round flows need nothing special; every round looks the
 * same.
 *
 * @module
 */
"use client";

import { FunctionReference } from "convex/server";
import { Fragment, useCallback, useState, type ReactNode } from "react";
import type { ClientView, SignInRequirement } from "../../lib/types.ts";
import { useAuthActions, useAuthSignInApi } from "../../react/index.tsx";
import type {
  ContinueSignInWithPasswordResult,
  SignInResult,
  SignUpResult,
} from "./setup.ts";
import type { SignInRequirements } from "../../lib/requirements.ts";

/** The `(username, password)` pair both flows accept. */
export type Credentials = { username: string; password: string };

/**
 * The `signInWithPassword` mutation the app re-exports from its auth setup.
 *
 * Its return value is the access-only {@link ClientView}, which is what both
 * session models have in common. Hand it to `setSession`, the only supported
 * consumer.
 *
 * This is the *bound* on what the hooks accept: generated references narrow
 * the incomplete arm's `requirements` to the app's registered requirement
 * kinds, and the hooks are generic over the actual reference so those types
 * flow through to the caller.
 */
type SignInWithPasswordMutation = FunctionReference<
  "mutation",
  "public",
  Credentials,
  ClientView<SignInResult<SignInRequirements>>
>;

/**
 * The `signUpWithPassword` mutation the app re-exports from its auth setup;
 * see {@link SignInWithPasswordMutation} on narrowing.
 */
type SignUpWithPasswordMutation = FunctionReference<
  "mutation",
  "public",
  Credentials,
  ClientView<SignUpResult<SignInRequirements>>
>;

/**
 * The `continueSignInWithPassword` mutation the app re-exports when it
 * registered sign-in requirements; see {@link SignInWithPasswordMutation} on
 * narrowing.
 */
type ContinueSignInWithPasswordMutation = FunctionReference<
  "mutation",
  "public",
  { attemptToken: string },
  ClientView<ContinueSignInWithPasswordResult<SignInRequirements>>
>;

/**
 * A failure the client produces that the server never returns: the mutation
 * threw (a network blip, a bug, an unexpected server error) rather than
 * resolving to a `userError`. The flow hooks fold that into the result as
 * `OTHER_ERROR` so callers handle *every* failure through the one `userError`
 * switch and never need their own `try`/`catch`. The thrown value is preserved
 * on `cause` for callers that want to inspect or log it.
 */
type UnexpectedFailure = {
  status: "error";
  userError: { error: "OTHER_ERROR"; cause: unknown };
};

/**
 * Augment the incomplete arm of a server result with `continueWith`, leaving
 * every other arm untouched. `ContinueResult` is the server result of the
 * continue mutation, whose incomplete arm is augmented the same way — so a
 * multi-round flow types the same at every round.
 */
type WithContinue<Result, ContinueResult> = Result extends {
  status: "incomplete";
}
  ? Result & {
      /**
       * Resume this sign-in, after satisfying (some of) the requirements:
       * re-evaluates server-side and resolves like the original call — to a
       * complete session, another incomplete result, or a failure
       * (`ATTEMPT_EXPIRED` once the attempt is gone; start over then).
       */
      continueWith: () => Promise<PasswordFlowResult<ContinueResult>>;
    }
  : Result;

/**
 * A flow result as returned to the app: the server result with the
 * incomplete arm augmented with `continueWith` and the failure arms widened
 * with the client-produced {@link UnexpectedFailure}.
 */
export type PasswordFlowResult<Result, ContinueResult = Result> =
  WithContinue<Result, ContinueResult> | UnexpectedFailure;

/** The result of the `signIn` callback from {@link useSignInWithPassword}. */
export type SignInWithPasswordResult = PasswordFlowResult<
  ClientView<SignInResult>
>;

/** The result of the `signUp` callback from {@link useSignUpWithPassword}. */
export type SignUpWithPasswordResult = PasswordFlowResult<
  ClientView<SignUpResult>
>;

/**
 * Client for the password provider's sign-in flow: wire the backend's
 * `signInWithPassword` mutation to the core client.
 *
 * The returned `signIn` runs the mutation with the given credentials and, on
 * success, establishes an authenticated session with your Convex backend.
 *
 * The `pending` flag returned will let you know if the credentials are
 * currently being validated.
 *
 * After calling `signIn`, switch on the `status` field of the return value
 * to see whether the sign-in succeeded, needs more from the user, or failed.
 *
 * ```tsx
 * import { useSignInWithPassword } from "@convex-dev/auth/providers/password/react";
 * import { api } from "../convex/_generated/api";
 *
 * function LogIn() {
 *   const { signIn, pending } = useSignInWithPassword(api.auth.signInWithPassword);
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const result = await signIn({ username, password });
 *         if (result.status !== "complete") {
 *           // map result.userError to a message
 *         }
 *       }}
 *     >
 *       <button disabled={pending}>Log in</button>
 *     </form>
 *   );
 * }
 * ```
 *
 * When the backend registered sign-in requirements, pass the app's
 * `continueSignInWithPassword` reference too, and handle the incomplete
 * result:
 *
 * ```tsx
 * const { signIn, pending } = useSignInWithPassword(
 *   api.auth.signInWithPassword,
 *   api.auth.continueSignInWithPassword,
 * );
 * // ...
 * const result = await signIn({ username, password });
 * if (result.status === "incomplete") {
 *   // walk the user through result.requirements, then:
 *   const next = await result.continueWith();
 * }
 * ```
 *
 * @param signInMutation The app's `signInWithPassword` mutation reference.
 * @param continueMutation The app's `continueSignInWithPassword` mutation
 *   reference; required to resume incomplete sign-ins.
 */
export function useSignInWithPassword<
  Result extends SignInWithPasswordMutation["_returnType"],
  ContinueResult extends ContinueSignInWithPasswordMutation["_returnType"] =
    never,
>(
  signInMutation: FunctionReference<"mutation", "public", Credentials, Result>,
  continueMutation?: FunctionReference<
    "mutation",
    "public",
    { attemptToken: string },
    ContinueResult
  >,
) {
  const { run, pending } = usePasswordFlow(signInMutation, continueMutation);
  return {
    /**
     * Passes up the given crendentials to perform a username/password sign in.
     *
     * Returns an object discriminated by `status`.
     *
     * On `"complete"` the sign-in worked and the client will establish
     * an authenticated session with the Convex backend server.
     *
     * On `"incomplete"` requirements are outstanding: walk the user through
     * `requirements`, then resume via `continueWith`. On `"error"` the
     * object has a `userError` field detailing why sign-in failed.
     */
    signIn: run,
    /** `true` if the sign-in attempt is being validated. */
    pending,
  };
}

/**
 * Client for the password provider's sign-up flow: wire the backend's
 * `signUpWithPassword` mutation to the core client.
 *
 * The returned `signUp` runs the mutation with the given credentials and, on
 * success, establishes an authenticated session with your Convex backend.
 *
 * The `pending` flag returned will let you know if the credentials are
 * currently being validated.
 *
 * After calling `signUp`, switch on the `status` field of the return value
 * to see whether the sign-up succeeded, needs more from the user, or failed.
 *
 * ```tsx
 * import { useSignUpWithPassword } from "@convex-dev/auth/providers/password/react";
 * import { api } from "../convex/_generated/api";
 *
 * function SignUp() {
 *   const { signUp, pending } = useSignUpWithPassword(api.auth.signUpWithPassword);
 *   // ...same shape as useSignInWithPassword
 * }
 * ```
 *
 * @param signUpMutation The backend's `signUpWithPassword` mutation reference.
 * @param continueMutation The app's `continueSignInWithPassword` mutation
 *   reference; required to resume incomplete sign-ups.
 */
export function useSignUpWithPassword<
  Result extends SignUpWithPasswordMutation["_returnType"],
  ContinueResult extends ContinueSignInWithPasswordMutation["_returnType"] =
    never,
>(
  signUpMutation: FunctionReference<"mutation", "public", Credentials, Result>,
  continueMutation?: FunctionReference<
    "mutation",
    "public",
    { attemptToken: string },
    ContinueResult
  >,
) {
  const { run, pending } = usePasswordFlow(signUpMutation, continueMutation);
  return {
    /**
     * Passes up the given crendentials to perform a username/password sign up.
     *
     * Returns an object discriminated by `status`.
     *
     * On `"complete"` the sign-up worked and the client will establish
     * an authenticated session with the Convex backend server.
     *
     * On `"incomplete"` requirements are outstanding: walk the user through
     * `requirements`, then resume via `continueWith`. On `"error"` the
     * object has a `userError` field detailing why sign-up failed.
     */
    signUp: run,
    /** `true` if the sign-up attempt is being validated. */
    pending,
  };
}

/** The loose structural shape the flow internals work against; the precise
 * types are re-applied on the hook's public signature. */
type AnyServerResult =
  | { status: "complete"; tokens: Parameters<SetSession>[0] }
  | {
      status: "incomplete";
      requirements: unknown[];
      attemptToken: string;
      expiresAt: number;
      continueWith?: () => Promise<AnyServerResult>;
    }
  | { status: "error"; userError: unknown };

type SetSession = ReturnType<typeof useAuthActions>["setSession"];

/**
 * Shared internals for sign-in and sign-up: run the mutation, adopt the
 * session on success, augment an incomplete result with `continueWith`, and
 * track in-flight state. The two flows are structurally identical and differ
 * only in the mutation they call and the name they expose the callback
 * under.
 */
function usePasswordFlow<
  Result extends ClientView<
    SignInResult<SignInRequirements> | SignUpResult<SignInRequirements>
  >,
  ContinueResult extends ClientView<
    ContinueSignInWithPasswordResult<SignInRequirements>
  > = never,
>(
  mutation: FunctionReference<"mutation", "public", Credentials, Result>,
  continueMutation?: FunctionReference<
    "mutation",
    "public",
    { attemptToken: string },
    ContinueResult
  >,
) {
  const { setSession } = useAuthActions();
  // Running through the signInApi rather than `useAction` is what lets these hooks
  // serve both session models. See {@link useAuthSignInApi}.
  const signInApi = useAuthSignInApi();
  const [pending, setPending] = useState(false);

  const handle = useCallback(
    async (result: AnyServerResult): Promise<AnyServerResult> => {
      if (result.status === "complete") {
        await setSession(result.tokens);
        return result;
      }
      if (result.status !== "incomplete") return result;

      // Requirements are outstanding: hand the caller the same result with
      // `continueWith` folded into it. Continuing funnels back through this
      // handler, so a multi-round flow needs no special handling anywhere.
      const continueWith = async (): Promise<AnyServerResult> => {
        if (continueMutation === undefined) {
          throw new Error(
            "The sign-in reported outstanding requirements but the hook was " +
              "given no continue mutation. Pass the app's " +
              "`continueSignInWithPassword` reference as the hook's second " +
              "argument.",
          );
        }
        try {
          const next = await signInApi.mutation(continueMutation, {
            attemptToken: result.attemptToken,
          });
          return await handle(next as AnyServerResult);
        } catch (cause) {
          return {
            status: "error",
            userError: { error: "OTHER_ERROR", cause },
          };
        }
      };
      return { ...result, continueWith };
    },
    [signInApi, continueMutation, setSession],
  );

  const run = useCallback(
    async (
      credentials: Credentials,
    ): Promise<PasswordFlowResult<Result, ContinueResult>> => {
      setPending(true);
      try {
        const result = await signInApi.mutation(mutation, credentials);
        return (await handle(result as AnyServerResult)) as PasswordFlowResult<
          Result,
          ContinueResult
        >;
      } catch (cause) {
        // The mutation threw instead of resolving to a `userError`. Fold it into
        // the same discriminated result as `OTHER_ERROR`, preserving the thrown
        // value on `cause`, so the caller handles it alongside every other
        // failure and can still inspect or log the original error if it wants.
        return { status: "error", userError: { error: "OTHER_ERROR", cause } };
      } finally {
        // Reset even when the mutation throws.
        setPending(false);
      }
    },
    [signInApi, mutation, handle],
  );

  return { run, pending };
}

// --- Requirements flow --------------------------------------------------------
//
// TODO: dowski - Everything below is password-flavored only through its type
// bounds (the shape of this provider's continue mutation); the mechanics are
// provider-agnostic. Once another provider supports sign-in requirements,
// consider moving these to a shared module parameterized over the provider's
// continue mutation.

/**
 * The incomplete result of any of this provider's flows, derived from the
 * app's `continueSignInWithPassword` reference alone — the incomplete arm is
 * structurally identical across sign-in, sign-up, and continuation, so one
 * reference names them all:
 *
 * ```ts
 * type Incomplete = PasswordIncomplete<
 *   typeof api.auth.continueSignInWithPassword
 * >;
 * ```
 *
 * This is the type to park in state when a flow comes back incomplete, and
 * what {@link useRequirementsFlow} takes over from there.
 */
export type PasswordIncomplete<
  Continue extends ContinueSignInWithPasswordMutation,
> = Extract<
  PasswordFlowResult<Continue["_returnType"]>,
  { status: "incomplete" }
>;

/**
 * What one {@link useRequirementsFlow} continuation round resolved to:
 * `complete` (a session was established; the app's auth state flips),
 * `incomplete` (requirements remain — the hook adopted the fresh round),
 * `expired` (the attempt is gone; `onExpired` was called), or `error` (the
 * mutation failed unexpectedly; see the hook's `error` state).
 */
export type ContinueSignInStatus =
  "complete" | "incomplete" | "expired" | "error";

/**
 * What a requirement handler (or a capability-authored requirement
 * component) receives alongside the requirement itself: the attempt's
 * bearer token to present to verification endpoints, and the two flow
 * signals — resume the sign-in, or report the attempt gone.
 *
 * The object {@link useRequirementsFlow} returns satisfies this shape, so
 * apps pass it straight through to {@link renderRequirements}.
 */
export type RequirementFlowContext = {
  /** The parked attempt's bearer token, for verification endpoints. */
  attemptToken: string;
  /** When the attempt expires (epoch ms). Continuing never extends it. */
  expiresAt: number;
  /**
   * Re-run evaluation, after verification endpoints have recorded their
   * facts. Resolves to what the round produced; on `incomplete` the flow
   * has already adopted the fresh requirements.
   */
  continueSignIn: () => Promise<ContinueSignInStatus>;
  /**
   * Report the attempt gone — e.g. a verification endpoint returned its
   * "expired" arm. Routes to the flow's `onExpired`.
   */
  expire: () => void;
};

/**
 * Per-kind requirement renderers, keyed by the closed requirement union the
 * generated api types carry. The record must name **every** registered
 * kind — registering a new requirement on the backend fails the build here
 * with a missing-property error until the UI handles it. The optional
 * `fallback` is the runtime backstop for version skew (a stale client
 * bundle against a backend that registered a kind this build predates);
 * requirement kinds are namespaced (`app:…`), so `fallback` can never
 * collide with one.
 */
export type RequirementHandlers<Req extends { kind: string }> = {
  [K in Req["kind"]]: (
    requirement: Extract<Req, { kind: K }>,
    context: RequirementFlowContext,
  ) => ReactNode;
} & {
  fallback?: (
    requirement: SignInRequirement,
    context: RequirementFlowContext,
  ) => ReactNode;
};

/**
 * Render each outstanding requirement through its kind's handler (see
 * {@link RequirementHandlers}). Headless: it owns the dispatch and the
 * exhaustiveness, not the form around it.
 *
 * ```tsx
 * {renderRequirements(flow.requirements, flow, {
 *   "mathFactor:problem": (req, ctx) => <MathChallenge context={ctx} />,
 *   fallback: (req) => <p>Can't satisfy: {req.kind}</p>,
 * })}
 * ```
 */
export function renderRequirements<Req extends { kind: string }>(
  requirements: readonly Req[],
  context: RequirementFlowContext,
  handlers: RequirementHandlers<Req>,
): ReactNode {
  const byKind = handlers as Record<
    string,
    | ((requirement: never, context: RequirementFlowContext) => ReactNode)
    | undefined
  >;
  return requirements.map((requirement) => {
    const handler = byKind[requirement.kind] ?? handlers.fallback;
    return (
      <Fragment key={requirement.kind}>
        {handler === undefined ? null : handler(requirement as never, context)}
      </Fragment>
    );
  });
}

/**
 * Own the requirements phase of a sign-in: hold the current incomplete
 * round, re-run evaluation via its `continueWith`, adopt the next round
 * when requirements remain, and fold the terminal arms into two signals —
 * `onExpired` when the attempt is gone (restart from the credentials form)
 * and the `error` state for unexpected failures.
 *
 * The returned object satisfies {@link RequirementFlowContext}, so it goes
 * straight into {@link renderRequirements} and capability components. A
 * completed continuation needs no handling here: `usePasswordFlow` already
 * adopted the session, and the app's authenticated state flips on its own.
 */
export function useRequirementsFlow<
  Incomplete extends {
    status: "incomplete";
    requirements: readonly { kind: string }[];
    attemptToken: string;
    expiresAt: number;
    continueWith: () => Promise<unknown>;
  },
>(initial: Incomplete, options: { onExpired: () => void }) {
  const { onExpired } = options;
  const [current, setCurrent] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UnexpectedFailure["userError"] | null>(
    null,
  );

  const continueSignIn =
    useCallback(async (): Promise<ContinueSignInStatus> => {
      setPending(true);
      setError(null);
      try {
        const next = (await current.continueWith()) as AnyServerResult;
        if (next.status === "complete") return "complete";
        if (next.status === "incomplete") {
          // The rounds of one flow all share the incomplete shape, so the
          // fresh round (requirements and continueWith included) slots in.
          setCurrent(next as unknown as Incomplete);
          return "incomplete";
        }
        const userError = next.userError as { error: string };
        if (userError.error === "ATTEMPT_EXPIRED") {
          onExpired();
          return "expired";
        }
        setError(next.userError as UnexpectedFailure["userError"]);
        return "error";
      } finally {
        setPending(false);
      }
    }, [current, onExpired]);

  return {
    /** The still-outstanding requirements of the current round. */
    requirements: current.requirements as Incomplete["requirements"],
    attemptToken: current.attemptToken,
    expiresAt: current.expiresAt,
    continueSignIn,
    expire: onExpired,
    /** `true` while a continuation round is in flight. */
    pending,
    /** The last continuation's unexpected failure, cleared on the next one. */
    error,
  };
}
