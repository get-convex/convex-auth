import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

type EnrollPhase =
  | { name: "idle" }
  | {
      name: "confirm";
      enrollmentId: string;
      secret: string;
      otpauthUrl: string;
    }
  | { name: "backup-codes"; backupCodes: string[] };

export function Dashboard() {
  const user = useQuery(api.users.currentUser);
  const { signOut } = useAuthActions();
  const startEnrollment = useAction(api.auth.startTotpEnrollment);
  const confirmEnrollment = useAction(api.auth.confirmTotpEnrollment);
  const disableTotp = useMutation(api.auth.disableTotp);
  const [phase, setPhase] = useState<EnrollPhase>({ name: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // startTotpEnrollment / disableTotp demand a RECENT sign-in and throw
  // ConvexError REAUTH_REQUIRED otherwise. The full re-auth UX lives in the
  // flow-step-up fixture; here we keep it to a message.
  async function withReauthNotice(call: () => Promise<void>) {
    setError(null);
    setPending(true);
    try {
      await call();
    } catch (error) {
      if (
        error instanceof ConvexError &&
        (error.data as any)?.code === "REAUTH_REQUIRED"
      ) {
        setError(
          "Recent sign-in required — see the flow-step-up fixture for the re-auth UX.",
        );
        return;
      }
      throw error;
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <h1>Dashboard</h1>
      <p>
        Signed in as <strong>{user?.email ?? "…"}</strong>. Two-factor auth
        is <strong>{user ? (user.totpEnrolled ? "on" : "off") : "…"}</strong>.
      </p>
      {error ? (
        <p role="alert">
          <strong>{error}</strong>
        </p>
      ) : null}
      {user && !user.totpEnrolled && phase.name === "idle" ? (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            void withReauthNotice(async () => {
              const enrollment = await startEnrollment({});
              setPhase({ name: "confirm", ...enrollment });
            })
          }
        >
          Enable two-factor auth
        </button>
      ) : null}
      {user?.totpEnrolled ? (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            void withReauthNotice(async () => {
              await disableTotp({});
              setPhase({ name: "idle" });
            })
          }
        >
          Disable 2FA
        </button>
      ) : null}
      {phase.name === "confirm" ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setPending(true);
            try {
              const result = await confirmEnrollment({
                enrollmentId: phase.enrollmentId,
                code,
              });
              if (result.ok) {
                // The ONLY time the backup codes are ever visible.
                setCode("");
                setPhase({
                  name: "backup-codes",
                  backupCodes: result.backupCodes,
                });
              } else {
                setError(
                  result.code === "CODE_INVALID"
                    ? "That code didn't match. Check your authenticator and try again."
                    : result.message,
                );
              }
            } finally {
              setPending(false);
            }
          }}
        >
          <h2>Set up your authenticator</h2>
          {/* A real UI would render otpauthUrl as a QR code; plain text
              keeps the fixture dependency-free. */}
          <p>
            Add this to your authenticator app:{" "}
            <code>{phase.otpauthUrl}</code>
          </p>
          <p>
            Or enter the secret manually: <code>{phase.secret}</code>
          </p>
          <label>
            Code from your app
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
          <button type="submit" disabled={pending}>
            {pending ? "Confirming…" : "Confirm enrollment"}
          </button>
        </form>
      ) : null}
      {phase.name === "backup-codes" ? (
        <>
          <h2>Backup codes</h2>
          <p>
            <strong>Save these now — you won't see them again.</strong> Each
            code signs you in once if you lose your authenticator.
          </p>
          <pre>{phase.backupCodes.join("\n")}</pre>
          <button type="button" onClick={() => setPhase({ name: "idle" })}>
            I saved them
          </button>
        </>
      ) : null}
      <p>
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </p>
    </>
  );
}
