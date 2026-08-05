import { useAuthActions } from "@convex-dev/auth/react";
import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";

type Phase =
  | { name: "completing" }
  | { name: "confirm-link"; flowId: string; maskedEmail: string }
  | { name: "error"; message: string };

/**
 * Landing route for the auth HTTP callback's 302. The redirect carries
 * `?flow=<flowId>&outcome=...`; `outcome` is only a routing hint — the
 * server's `completeOAuth` result is the single source of truth, so this
 * client never branches on it.
 */
export function Callback() {
  const { setSession } = useAuthActions();
  const completeOAuth = useAction(api.auth.completeOAuth);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [phase, setPhase] = useState<Phase>({ name: "completing" });
  // completeOAuth redeems a one-time flow ticket: a second call on the same
  // flowId gets FLOW_EXPIRED, never tokens. This ref guards against React
  // StrictMode's double-invoked effect so the ticket is spent exactly once;
  // if a double call slips through anyway, the FLOW_EXPIRED branch below is
  // the tolerant handling.
  const started = useRef(false);

  const flowId = params.get("flow");
  // Read but intentionally unused: `outcome` lets an app pre-render the
  // right shell (spinner vs. form) before completeOAuth answers, but the
  // server result below is the single source of truth for what happened.
  const outcome = params.get("outcome");
  void outcome;

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    if (flowId === null) {
      setPhase({
        name: "error",
        message: "Missing sign-in state. Start over.",
      });
      return;
    }
    void (async () => {
      const result = await completeOAuth({ flowId });
      switch (result.status) {
        case "complete":
          // Known identity, safe auto-link, or brand-new user — the server
          // decided which; the client just gets a session.
          await setSession(result.tokens);
          navigate("/", { replace: true });
          return;
        case "needs":
          // Only "confirm-link" is reachable in this flow: an account with
          // this email exists but trust is insufficient for auto-linking.
          // Nothing has been linked yet.
          setPhase({
            name: "confirm-link",
            flowId: result.flowId,
            maskedEmail: String(result.detail?.maskedEmail ?? "your account"),
          });
          return;
        case "error":
          setPhase({
            name: "error",
            message:
              result.code === "FLOW_EXPIRED"
                ? "This sign-in expired or was already used. Start over."
                : result.code === "RATE_LIMITED"
                  ? "Too many attempts. Try again shortly."
                  : result.message,
          });
          return;
        default:
          result satisfies never;
      }
    })();
  }, [flowId, completeOAuth, setSession, navigate]);

  if (phase.name === "completing") {
    return <p>Completing sign-in…</p>;
  }
  if (phase.name === "error") {
    return (
      <>
        <h1>Sign-in failed</h1>
        <p role="alert">
          <strong>{phase.message}</strong>
        </p>
        <p>
          <a href="/login">Back to log in</a>
        </p>
      </>
    );
  }
  return <ConfirmLink flowId={phase.flowId} maskedEmail={phase.maskedEmail} />;
}

function ConfirmLink({
  flowId,
  maskedEmail,
}: {
  flowId: string;
  maskedEmail: string;
}) {
  const { setSession } = useAuthActions();
  const confirmLink = useAction(api.auth.confirmLinkWithPassword);
  const navigate = useNavigate();
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
            const result = await confirmLink({ flowId, password });
            switch (result.status) {
              case "complete":
                // Only now — after the password verified — has the OAuth
                // identity been linked to the existing account.
                await setSession(result.tokens);
                navigate("/", { replace: true });
                return;
              case "needs":
                return; // Not reachable in this flow.
              case "error":
                setError(
                  result.code === "INVALID_CREDENTIALS"
                    ? "Incorrect password."
                    : result.code === "RATE_LIMITED"
                      ? "Too many attempts. Try again shortly."
                      : "This linking flow expired. Start over from the login page.",
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
        <h1>Link your account</h1>
        <p>
          An account already exists for <strong>{maskedEmail}</strong> — enter
          its password to link this sign-in to it.
        </p>
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
          {pending ? "Linking…" : "Link accounts"}
        </button>
      </form>
      <p>
        {/* Abandoning here links nothing; both accounts stay untouched. */}
        <a href="/login">Cancel and start over</a>
      </p>
    </>
  );
}
