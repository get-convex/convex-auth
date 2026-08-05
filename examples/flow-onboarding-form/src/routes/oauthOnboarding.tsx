import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { OnboardingForm } from "../OnboardingForm";

type Phase =
  | { name: "start" }
  | {
      name: "onboarding";
      flowId: string;
      email?: string;
      displayName?: string;
    };

export function OAuthOnboarding() {
  const simulateOAuthArrival = useAction(api.auth.simulateOAuthArrival);
  const [phase, setPhase] = useState<Phase>({ name: "start" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (phase.name === "onboarding") {
    // Same component, same server-side validation as the /signup leg —
    // pre-filled from the detail the flow carried.
    return (
      <OnboardingForm
        flowId={phase.flowId}
        email={phase.email}
        initialDisplayName={phase.displayName}
      />
    );
  }

  return (
    <>
      <h1>OAuth arrival without a profile</h1>
      <p>
        In the real flow this page would be the OAuth redirect landing: the
        provider authenticated the user, but the app requires profile fields
        the provider can't supply, so the server parks the flow at{" "}
        <code>needs: "onboarding"</code> instead of creating a user.
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          setError(null);
          setPending(true);
          try {
            const result = await simulateOAuthArrival({});
            switch (result.status) {
              case "needs":
                setPhase({
                  name: "onboarding",
                  flowId: result.flowId,
                  email:
                    typeof result.detail?.email === "string"
                      ? result.detail.email
                      : undefined,
                  displayName:
                    typeof result.detail?.name === "string"
                      ? result.detail.name
                      : undefined,
                });
                return;
              case "complete":
                return; // Not reachable: the simulation always needs onboarding.
              case "error":
                setError(result.message);
                return;
              default:
                result satisfies never;
            }
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "Redirecting…" : "Simulate: arrive via OAuth without a profile"}
      </button>
      {error ? (
        <p role="alert">
          <strong>{error}</strong>
        </p>
      ) : null}
      <p>
        Or <a href="/signup">sign up with everything up front</a>.
      </p>
    </>
  );
}
