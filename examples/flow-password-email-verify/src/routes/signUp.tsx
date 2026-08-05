import { useAuthActions } from "@convex-dev/auth/react";
import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

// Persist the pending flow so a page reload lands back on the code-entry
// step. Flows are resumable server-side; this is just client bookkeeping.
const FLOW_KEY = "signup-flow";

type Phase =
  | { name: "form" }
  | { name: "verify-email"; flowId: string; email: string };

function initialPhase(): Phase {
  const saved = sessionStorage.getItem(FLOW_KEY);
  return saved ? { name: "verify-email", ...JSON.parse(saved) } : { name: "form" };
}

export function SignUp() {
  const [phase, setPhase] = useState<Phase>(initialPhase);

  return phase.name === "form" ? (
    <SignUpForm
      onPending={(flowId, email) => {
        sessionStorage.setItem(FLOW_KEY, JSON.stringify({ flowId, email }));
        setPhase({ name: "verify-email", flowId, email });
      }}
    />
  ) : (
    <VerifyEmail
      flowId={phase.flowId}
      email={phase.email}
      onStartOver={() => {
        sessionStorage.removeItem(FLOW_KEY);
        setPhase({ name: "form" });
      }}
    />
  );
}

function SignUpForm({
  onPending,
}: {
  onPending: (flowId: string, email: string) => void;
}) {
  const signUp = useAction(api.auth.signUp);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setPending(true);
          try {
            const result = await signUp({ email, password });
            switch (result.status) {
              case "needs":
                // Always "verify-email" for this flow: no user document
                // exists yet, and won't until the code is consumed.
                onPending(result.flowId, email);
                return;
              case "complete":
                // Not reachable in this flow (verification is required),
                // but handled so the union stays exhaustive.
                return;
              case "error":
                setError(
                  result.code === "PASSWORD_TOO_SHORT"
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
        {error ? (
          <p role="alert">
            <strong>{error}</strong>
          </p>
        ) : null}
        <button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Continue"}
        </button>
      </form>
      <p>
        Already have an account? <a href="/login">Log in</a>
      </p>
    </>
  );
}

function VerifyEmail({
  flowId,
  email,
  onStartOver,
}: {
  flowId: string;
  email: string;
  onStartOver: () => void;
}) {
  const { setSession } = useAuthActions();
  const verifyEmail = useAction(api.auth.verifyEmail);
  const resend = useAction(api.auth.resendVerification);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setPending(true);
          try {
            const result = await verifyEmail({ flowId, code });
            switch (result.status) {
              case "complete":
                // The user document was created just now, server-side, with
                // an already-verified email.
                sessionStorage.removeItem(FLOW_KEY);
                await setSession(result.tokens);
                return;
              case "error":
                if (result.code === "FLOW_EXPIRED") {
                  setError("This sign-up expired. Start over.");
                } else if (result.code === "CODE_EXPIRED") {
                  setError("That code expired. Resend and try again.");
                } else {
                  setError("Incorrect code.");
                }
                return;
              case "needs":
                return; // Not reachable in this flow.
              default:
                result satisfies never;
            }
          } finally {
            setPending(false);
          }
        }}
      >
        <h1>Check your email</h1>
        <p>
          We sent a 6-digit code to <strong>{email}</strong>. Your account
          isn't created until you enter it.
        </p>
        <label>
          Code
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            disabled={pending}
          />
        </label>
        {error ? (
          <p role="alert">
            <strong>{error}</strong>
          </p>
        ) : null}
        {notice ? <p>{notice}</p> : null}
        <button type="submit" disabled={pending}>
          {pending ? "Verifying…" : "Verify"}
        </button>
      </form>
      <p>
        <button
          type="button"
          onClick={async () => {
            setNotice(null);
            setError(null);
            const result = await resend({ flowId });
            if (result.ok) {
              setNotice("Code re-sent.");
            } else if (result.code === "RATE_LIMITED") {
              setError("Too many sends. Wait a moment.");
            } else {
              setError("This sign-up expired. Start over.");
            }
          }}
        >
          Resend code
        </button>{" "}
        <button type="button" onClick={onStartOver}>
          Start over
        </button>
      </p>
    </>
  );
}
