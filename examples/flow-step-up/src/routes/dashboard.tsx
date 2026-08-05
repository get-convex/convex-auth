import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import { useStepUp } from "../useStepUp";

export function Dashboard() {
  const user = useQuery(api.users.currentUser);
  const freshness = useQuery(api.auth.authFreshness);
  const revealApiSecret = useAction(api.account.revealApiSecret);
  const deleteAccount = useMutation(api.account.deleteAccount);
  const stepUp = useStepUp();
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");

  return (
    <>
      <h1>Account</h1>
      <p>
        Signed in as <strong>{user?.email ?? "…"}</strong>.
      </p>
      <FreshnessIndicator freshUntil={freshness?.freshUntil ?? null} />

      <h2>API secret</h2>
      <button
        type="button"
        onClick={() =>
          void stepUp.run(async () => {
            const result = await revealApiSecret({});
            setSecret(result.secret);
          })
        }
      >
        Reveal API secret
      </button>
      {secret !== null ? (
        <p>
          <code>{secret}</code>
        </p>
      ) : null}

      <h2>Danger zone</h2>
      <p>
        Deleting your account is permanent. This operation demands an even
        fresher sign-in than revealing the secret (1 minute vs. 5) — the
        server decides per operation.
      </p>
      <label>
        Type DELETE to confirm
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={confirmText !== "DELETE"}
        onClick={() =>
          void stepUp.run(async () => {
            await deleteAccount({ confirm: "DELETE" });
          })
        }
      >
        Delete account
      </button>

      {stepUp.needsReauth ? <ReauthModal stepUp={stepUp} /> : null}
    </>
  );
}

/**
 * Countdown driven by the reactive authFreshness query. Advisory UX only:
 * the real guards live server-side in convex/account.ts — hiding or
 * showing UI here enforces nothing.
 */
function FreshnessIndicator({ freshUntil }: { freshUntil: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (freshUntil === null || freshUntil <= now) {
    return <p>Sensitive actions will ask you to confirm your password.</p>;
  }
  const remaining = freshUntil - now;
  const mm = String(Math.floor(remaining / 60_000)).padStart(2, "0");
  const ss = String(Math.floor((remaining % 60_000) / 1000)).padStart(2, "0");
  return (
    <p>
      Session verified — sensitive actions unlocked for{" "}
      <strong>
        {mm}:{ss}
      </strong>
    </p>
  );
}

/**
 * The step-up prompt: confirm your password, and the operation you just
 * attempted is retried automatically. No sign-out, no new session.
 */
function ReauthModal({ stepUp }: { stepUp: ReturnType<typeof useStepUp> }) {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        try {
          await stepUp.submitPassword(password);
        } finally {
          setPending(false);
        }
      }}
    >
      <h2>Confirm it's you</h2>
      <p>
        This action needs a recent sign-in. Confirm with:{" "}
        <strong>{stepUp.methods.join(", ") || "password"}</strong>.
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
      {stepUp.error ? (
        <p role="alert">
          <strong>{stepUp.error}</strong>
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? "Confirming…" : "Confirm and retry"}
      </button>{" "}
      <button type="button" onClick={stepUp.cancel} disabled={pending}>
        Cancel
      </button>
    </form>
  );
}
