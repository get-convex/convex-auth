import { useAuthActions } from "@convex-dev/auth/react";
import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { OnboardingForm, Role } from "../OnboardingForm";

type Phase = { name: "form" } | { name: "onboarding"; flowId: string };

export function SignUp() {
  const { setSession } = useAuthActions();
  const signUp = useAction(api.auth.signUp);
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<Role>("engineer");
  const [tosAccepted, setTosAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (phase.name === "onboarding") {
    // The server parked the flow at needs:"onboarding": the SAME component
    // (and the same server-side validation) as the post-OAuth leg on
    // /oauth-onboarding takes over.
    return (
      <OnboardingForm
        flowId={phase.flowId}
        email={email}
        initialDisplayName={displayName}
      />
    );
  }

  return (
    <>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setPending(true);
          try {
            const result = await signUp({
              email,
              password,
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
                // Profile validated and user created in one step, fields
                // populated at birth.
                await setSession(result.tokens);
                return;
              case "needs":
                // The server wants more onboarding; hand off to the shared
                // onboarding form.
                setPhase({ name: "onboarding", flowId: result.flowId });
                return;
              case "error":
                setError(
                  result.code === "TOS_NOT_ACCEPTED"
                    ? "You must accept the terms."
                    : result.code === "INVALID_PROFILE"
                      ? result.message
                      : result.code === "PASSWORD_TOO_SHORT"
                        ? "Password is too short."
                        : result.code === "PASSWORD_BREACHED"
                          ? "That password has appeared in a data breach. Pick another."
                          : result.message,
                );
                return;
              default:
                result satisfies never;
            }
          } finally {
            setPending(false);
          }
        }}
      >
        <h1>Create account</h1>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            disabled={pending}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            disabled={pending}
          />
        </label>
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
          {pending ? "Creating…" : "Create account"}
        </button>
      </form>
      <p>
        Trying the other ordering?{" "}
        <a href="/oauth-onboarding">Arrive via OAuth without a profile</a>
      </p>
    </>
  );
}
