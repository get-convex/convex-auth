import { useAuthActions } from "@convex-dev/auth/react";
import { useAction } from "convex/react";
import { ConvexError } from "convex/values";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

// Persist the pending flow so a page reload lands back on the code-entry
// step. Flows are resumable server-side; this is just client bookkeeping.
const FLOW_KEY = "otp-flow";

type Phase =
  | { name: "form" }
  | { name: "code"; flowId: string; email: string };

function initialPhase(): Phase {
  const saved = sessionStorage.getItem(FLOW_KEY);
  return saved ? { name: "code", ...JSON.parse(saved) } : { name: "form" };
}

// `requestCode` has a fixed success shape, so rate limiting surfaces as a
// thrown ConvexError with { code: "RATE_LIMITED" } — the one auth error this
// client has to catch rather than switch on.
function isRateLimited(err: unknown): boolean {
  return (
    err instanceof ConvexError &&
    typeof err.data === "object" &&
    err.data !== null &&
    (err.data as { code?: unknown }).code === "RATE_LIMITED"
  );
}

export function LogIn() {
  const [phase, setPhase] = useState<Phase>(initialPhase);

  return phase.name === "form" ? (
    <EmailForm
      onPending={(flowId, email) => {
        sessionStorage.setItem(FLOW_KEY, JSON.stringify({ flowId, email }));
        setPhase({ name: "code", flowId, email });
      }}
    />
  ) : (
    <EnterCode
      flowId={phase.flowId}
      email={phase.email}
      onStartOver={() => {
        sessionStorage.removeItem(FLOW_KEY);
        setPhase({ name: "form" });
      }}
    />
  );
}

function EmailForm({
  onPending,
}: {
  onPending: (flowId: string, email: string) => void;
}) {
  const requestCode = useAction(api.auth.requestCode);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setPending(true);
        try {
          // Always succeeds with the same shape whether or not this email
          // has an account — the UI is identical for new and returning
          // users by design.
          const { flowId } = await requestCode({ email });
          onPending(flowId, email);
        } catch (err) {
          if (isRateLimited(err)) {
            setError("Too many codes requested. Wait a moment.");
          } else {
            throw err;
          }
        } finally {
          setPending(false);
        }
      }}
    >
      <h1>Sign in</h1>
      <p>No password — we'll email you a 6-digit code.</p>
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
      {error ? (
        <p role="alert">
          <strong>{error}</strong>
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Email me a code"}
      </button>
    </form>
  );
}

function EnterCode({
  flowId,
  email,
  onStartOver,
}: {
  flowId: string;
  email: string;
  onStartOver: () => void;
}) {
  const { setSession } = useAuthActions();
  const verifyCode = useAction(api.auth.verifyCode);
  const requestCode = useAction(api.auth.requestCode);
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
            const result = await verifyCode({ flowId, code });
            switch (result.status) {
              case "complete":
                // First-time email: the user document was created just now,
                // server-side. Returning email: resolved to the existing
                // user. The client can't tell, and shouldn't.
                sessionStorage.removeItem(FLOW_KEY);
                await setSession(result.tokens);
                return;
              case "error":
                if (result.code === "FLOW_EXPIRED") {
                  setError("This sign-in expired. Start over.");
                } else if (result.code === "CODE_EXPIRED") {
                  setError("That code expired. Resend and try again.");
                } else {
                  // CODE_INVALID: the server words remaining attempts into
                  // the message itself.
                  setError(result.message);
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
          We sent a 6-digit code to <strong>{email}</strong>.
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
          {pending ? "Verifying…" : "Sign in"}
        </button>
      </form>
      <p>
        <button
          type="button"
          onClick={async () => {
            setNotice(null);
            setError(null);
            try {
              // Re-requesting for the same email rotates the code but keeps
              // the same flowId, so this screen stays valid.
              await requestCode({ email });
              setNotice("Code re-sent.");
            } catch (err) {
              if (isRateLimited(err)) {
                setError("Too many sends. Wait a moment.");
              } else {
                throw err;
              }
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
