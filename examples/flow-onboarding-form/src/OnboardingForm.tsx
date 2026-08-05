import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../convex/_generated/api";

export type Role = "engineer" | "designer" | "other";

/**
 * The shared onboarding form, used by both orderings:
 * - `/signup`, when `auth.signUp` parks the flow at `needs: "onboarding"`;
 * - `/oauth-onboarding`, after a (simulated) OAuth arrival that
 *   authenticated but lacked the required profile fields.
 * Either way it submits `auth.completeOnboarding`, which runs the same
 * server-side validation as up-front sign-up.
 */
export function OnboardingForm({
  flowId,
  email,
  initialDisplayName,
}: {
  flowId: string;
  email?: string;
  initialDisplayName?: string;
}) {
  const { setSession } = useAuthActions();
  const completeOnboarding = useAction(api.auth.completeOnboarding);
  // Reactive view of the parked flow: a reload or a second tab can
  // subscribe with the flowId and land on the same step; null means the
  // flow completed or expired.
  const flow = useQuery(api.auth.flowStatus, { flowId });
  const [displayName, setDisplayName] = useState(initialDisplayName ?? "");
  const [role, setRole] = useState<Role>("engineer");
  const [tosAccepted, setTosAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setPending(true);
        try {
          const result = await completeOnboarding({
            flowId,
            profile: {
              displayName,
              role,
              // null when unchecked — enforcement is server-side on
              // purpose (TOS_NOT_ACCEPTED), not an HTML `required`.
              tosVersion: tosAccepted ? "2026-06" : null,
            },
          });
          switch (result.status) {
            case "complete":
              // The user was created just now, server-side, from the
              // provider claims parked on the flow merged with this
              // profile. The flow is consumed (single-use).
              await setSession(result.tokens);
              return;
            case "error":
              setError(
                result.code === "TOS_NOT_ACCEPTED"
                  ? "You must accept the terms."
                  : result.code === "INVALID_PROFILE"
                    ? result.message
                    : result.code === "FLOW_EXPIRED"
                      ? "This flow expired. Start over."
                      : result.message,
              );
              return;
            case "needs":
              return; // Not reachable: onboarding is the last step here.
            default:
              result satisfies never;
          }
        } finally {
          setPending(false);
        }
      }}
    >
      <h1>Finish setting up your account</h1>
      {email ? (
        <p>
          Continuing as <strong>{email}</strong>.
        </p>
      ) : null}
      {flow ? (
        <p>
          This sign-in is waiting on: <strong>{flow.step}</strong>.
        </p>
      ) : null}
      <label>
        Display name
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          disabled={pending}
        />
      </label>
      <label>
        Role
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          disabled={pending}
        >
          <option value="engineer">Engineer</option>
          <option value="designer">Designer</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={tosAccepted}
          onChange={(e) => setTosAccepted(e.target.checked)}
          disabled={pending}
        />{" "}
        I agree to the Terms (v2026-06)
      </label>
      {error ? (
        <p role="alert">
          <strong>{error}</strong>
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Finish"}
      </button>
    </form>
  );
}
