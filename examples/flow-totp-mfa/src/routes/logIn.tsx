import { useAuthActions } from "@convex-dev/auth/react";
import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

// Persist the pending challenge so a page reload lands back on code entry.
// The flow itself is resumable server-side; this is just client bookkeeping.
const FLOW_KEY = "mfa-flow";

type Phase = { name: "form" } | { name: "totp"; flowId: string };

function initialPhase(): Phase {
  const saved = sessionStorage.getItem(FLOW_KEY);
  return saved ? { name: "totp", ...JSON.parse(saved) } : { name: "form" };
}

export function LogIn() {
  const [phase, setPhase] = useState<Phase>(initialPhase);

  return phase.name === "form" ? (
    <PasswordForm
      onChallenge={(flowId) => {
        sessionStorage.setItem(FLOW_KEY, JSON.stringify({ flowId }));
        setPhase({ name: "totp", flowId });
      }}
    />
  ) : (
    <TotpChallenge
      flowId={phase.flowId}
      onStartOver={() => {
        sessionStorage.removeItem(FLOW_KEY);
        setPhase({ name: "form" });
      }}
    />
  );
}

function PasswordForm({
  onChallenge,
}: {
  onChallenge: (flowId: string) => void;
}) {
  const { setSession } = useAuthActions();
  const signIn = useAction(api.auth.signIn);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setPending(true);
        try {
          const result = await signIn({ email, password });
          switch (result.status) {
            case "complete":
              // This account has no second factor enrolled.
              await setSession(result.tokens);
              return;
            case "needs":
              // step "totp": the password checked out, but the account has
              // TOTP enrolled. The verification is parked on the flow —
              // there is NO session yet.
              onChallenge(result.flowId);
              return;
            case "error":
              setError(
                result.code === "RATE_LIMITED"
                  ? "Too many attempts. Try again shortly."
                  : "Incorrect email or password.",
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
      <h1>Log in</h1>
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
          autoComplete="current-password"
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
        {pending ? "Logging in…" : "Log in"}
      </button>
    </form>
  );
}

function TotpChallenge({
  flowId,
  onStartOver,
}: {
  flowId: string;
  onStartOver: () => void;
}) {
  const { setSession } = useAuthActions();
  const verifyTotp = useAction(api.auth.verifyTotp);
  const redeemBackupCode = useAction(api.auth.useBackupCode);
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState("");
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
            // Same flowId, two ways to satisfy the second factor.
            const result = useBackup
              ? await redeemBackupCode({ flowId, code })
              : await verifyTotp({ flowId, code });
            switch (result.status) {
              case "complete":
                // Only now does a session exist; abandoning before this
                // point left the user signed out.
                sessionStorage.removeItem(FLOW_KEY);
                await setSession(result.tokens);
                return;
              case "error":
                if (result.code === "FLOW_EXPIRED") {
                  setError(
                    "Too many attempts or the challenge expired. Sign in again.",
                  );
                } else {
                  setError(
                    useBackup
                      ? "That backup code didn't work. Codes are single-use."
                      : "Incorrect code.",
                  );
                }
                return;
              case "needs":
                return; // Not reachable: the second factor is the last step.
              default:
                result satisfies never;
            }
          } finally {
            setPending(false);
          }
        }}
      >
        <h1>Two-factor authentication</h1>
        <p>
          {useBackup
            ? "Enter one of your single-use backup codes."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
        <label>
          {useBackup ? "Backup code" : "Code"}
          <input
            type="text"
            inputMode={useBackup ? "text" : "numeric"}
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
        <button type="submit" disabled={pending}>
          {pending ? "Verifying…" : "Verify"}
        </button>
      </form>
      <p>
        <button
          type="button"
          onClick={() => {
            setUseBackup((b) => !b);
            setCode("");
            setError(null);
          }}
        >
          {useBackup ? "Use your authenticator instead" : "Use a backup code instead"}
        </button>{" "}
        <button type="button" onClick={onStartOver}>
          Start over
        </button>
      </p>
    </>
  );
}
