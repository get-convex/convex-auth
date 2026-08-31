import {
  renderRequirements,
  useRequirementsFlow,
  type PasswordIncomplete,
} from "@convex-dev/auth/providers/password/react";
import { useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";

/**
 * An incomplete flow result — the outstanding requirements, the attempt
 * token for the factor's endpoints, and the `continueWith` to resume with —
 * derived from the app's continue reference alone (the incomplete arm is
 * identical across sign-in, sign-up, and continuation). Both the log-in and
 * sign-up pages park one of these in state and render this step.
 */
export type IncompleteResult = PasswordIncomplete<
  typeof api.auth.continueSignInWithPassword
>;

/**
 * Generic UI for an incomplete sign-in. Requirements are satisfied by
 * server-verified facts: for the math factor, the client drives the
 * factor's own endpoints — fetch the challenge, submit the answer — and on
 * success the server records a fact on the attempt. `useRequirementsFlow`
 * owns the rest: continuing re-evaluates, a completed sign-in flips the
 * app's authenticated state (navigation happens on its own), a
 * still-incomplete round is adopted in place, and an expired attempt hands
 * control back to the credentials form via `onRestart`.
 */
export function RequirementsStep({
  initial,
  onRestart,
}: {
  initial: IncompleteResult;
  onRestart: (message: string) => void;
}) {
  const flow = useRequirementsFlow(initial, {
    onExpired: () =>
      onRestart("Your sign-in attempt expired. Please start over."),
  });
  const [answer, setAnswer] = useState("");
  const [question, setQuestion] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getMathChallenge = useMutation(api.auth.getMathChallenge);
  const verifyMathAnswer = useMutation(api.auth.verifyMathAnswer);

  const { attemptToken, expire } = flow;
  const needsMath = flow.requirements.some(
    (r) => r.kind === "mathFactor:problem",
  );

  useEffect(() => {
    if (!needsMath) return;
    let cancelled = false;
    getMathChallenge({ attemptToken }).then((challenge) => {
      if (cancelled) return;
      if (challenge.status === "expired") {
        expire();
        return;
      }
      setQuestion(challenge.question);
    });
    return () => {
      cancelled = true;
    };
  }, [needsMath, attemptToken, getMathChallenge, expire]);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setPending(true);
        try {
          // Verify the factor against its own endpoint first: a correct
          // answer records the `mathVerified` fact on the attempt,
          // server-side.
          if (needsMath) {
            const verdict = await verifyMathAnswer({
              attemptToken,
              answer: Number(answer),
            });
            if (verdict.status === "expired") {
              expire();
              return;
            }
            if (verdict.status === "incorrect") {
              setAnswer("");
              setError("That wasn’t right — try again.");
              return;
            }
          }
          // Then resume the sign-in: the evaluator re-runs against the
          // freshly recorded facts. "complete" and "expired" are handled by
          // the flow (auth state / onExpired); "error" renders below from
          // flow.error.
          const status = await flow.continueSignIn();
          if (status === "incomplete") setAnswer("");
        } finally {
          setPending(false);
        }
      }}
    >
      <h1>Almost there</h1>
      {renderRequirements(flow.requirements, flow, {
        // The record must name every registered kind: registering a new
        // requirement on the backend breaks the build here (a missing
        // property) until the UI handles it.
        "mathFactor:problem": () => (
          <label>
            {question === null ? "Loading challenge…" : `What is ${question}?`}
            <input
              type="text"
              inputMode="numeric"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              required
              disabled={pending || question === null}
            />
          </label>
        ),
        // Runtime backstop for version skew (a stale client bundle against
        // a backend that registered a kind this build predates).
        fallback: (req) => (
          <p role="alert">
            This app can’t satisfy the requirement: <strong>{req.kind}</strong>
          </p>
        ),
      })}
      {error !== null || flow.error !== null ? (
        <p role="alert">
          <strong>{error ?? "Something went wrong. Please try again."}</strong>
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? "Checking…" : "Continue"}
      </button>
    </form>
  );
}
