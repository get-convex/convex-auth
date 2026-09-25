import type {
  ConfirmTotpEnrollmentResult,
  DisableTotpResult,
  RegenerateBackupCodesResult,
} from "@convex-dev/auth/totp/setup";
import { useMutation, useQuery } from "convex/react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { api } from "../convex/_generated/api";

/**
 * Lets the signed-in user turn on a second factor: they scan (or type) a
 * secret into an authenticator app, confirm it with a code, and save their
 * backup codes. Once enabled, logging in asks for a code after the password.
 */
export function TotpSettings() {
  const user = useQuery(api.currentUser.loggedInUser);
  const status = useQuery(api.auth.getTotpStatus);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  if (!user || status === undefined || status === null) {
    // Loading, or not signed in
    return null;
  }

  return (
    <section>
      <h2>Two-factor authentication</h2>
      {backupCodes ? (
        <BackupCodes codes={backupCodes} onDone={() => setBackupCodes(null)} />
      ) : status.enabled ? (
        <Enabled
          remainingBackupCodes={status.remainingBackupCodes}
          onBackupCodes={setBackupCodes}
        />
      ) : (
        <Enroll accountName={user.username} onEnrolled={setBackupCodes} />
      )}
    </section>
  );
}

function Enroll({
  accountName,
  onEnrolled,
}: {
  accountName: string;
  onEnrolled: (backupCodes: string[]) => void;
}) {
  const start = useMutation(api.auth.startTotpEnrollment);
  const confirm = useMutation(api.auth.confirmTotpEnrollment);
  const [secret, setSecret] = useState<{
    secret: string;
    otpauthUri: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  if (secret === null) {
    return (
      <>
        <p>Ask for a code from an authenticator app at every login.</p>
        <button
          type="button"
          disabled={pending}
          onClick={async () => {
            setStatus(null);
            setPending(true);
            try {
              const result = await start({ accountName });
              if (result.success) {
                setSecret(result);
              } else {
                setStatus("Your session has ended. Please log in again.");
              }
            } catch (cause) {
              console.error("Could not start the enrollment:", cause);
              setStatus("Something went wrong. Please try again.");
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Preparing…" : "Set up an authenticator app"}
        </button>
        {status && (
          <p role="alert">
            <strong>{status}</strong>
          </p>
        )}
      </>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setStatus(null);
        setPending(true);
        try {
          const result = await confirm({ code });
          if (result.success) {
            onEnrolled(result.backupCodes);
          } else {
            setStatus(confirmErrorMessage(result.userError));
          }
        } catch (cause) {
          console.error("Could not confirm the enrollment:", cause);
          setStatus("Something went wrong. Please try again.");
        } finally {
          setPending(false);
        }
      }}
    >
      <p>
        Open your authenticator app and add this account. Scan the QR code, open
        the setup link on this device, or type the secret in by hand.
      </p>
      <p>
        <QRCodeSVG
          value={secret.otpauthUri}
          size={192}
          marginSize={2}
          aria-label="QR code for the authenticator app"
        />
      </p>
      <p>
        <a href={secret.otpauthUri}>Add to authenticator app</a>
      </p>
      <p>
        Secret: <code>{secret.secret}</code>
      </p>
      <label htmlFor="enrollment-code">
        Then enter the code the app shows
        <input
          id="enrollment-code"
          name="enrollment-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          disabled={pending}
        />
      </label>
      {status && (
        <p role="alert">
          <strong>{status}</strong>
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "Confirming…" : "Turn on"}
      </button>{" "}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          // The unconfirmed secret on the server grants nothing, and the next
          // start replaces it, so there is nothing to tell the server.
          setSecret(null);
          setCode("");
          setStatus(null);
        }}
      >
        Cancel
      </button>
    </form>
  );
}

function Enabled({
  remainingBackupCodes,
  onBackupCodes,
}: {
  remainingBackupCodes: number;
  onBackupCodes: (codes: string[]) => void;
}) {
  const disable = useMutation(api.auth.disableTotp);
  const regenerate = useMutation(api.auth.regenerateBackupCodes);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  return (
    <>
      <p>
        Two-factor authentication is <strong>on</strong>. You have{" "}
        {remainingBackupCodes} backup{" "}
        {remainingBackupCodes === 1 ? "code" : "codes"} left.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const action = (e.nativeEvent as SubmitEvent).submitter?.getAttribute(
            "value",
          );
          setStatus(null);
          setPending(true);
          try {
            if (action === "regenerate") {
              const result = await regenerate({ code });
              if (result.success) {
                setCode("");
                onBackupCodes(result.backupCodes);
              } else {
                setStatus(codeErrorMessage(result.userError));
              }
            } else {
              const result = await disable({ code });
              if (result.success) {
                setCode("");
                setStatus("Two-factor authentication is off.");
              } else {
                setStatus(codeErrorMessage(result.userError));
              }
            }
          } catch (cause) {
            console.error("Could not change two-factor auth:", cause);
            setStatus("Something went wrong. Please try again.");
          } finally {
            setPending(false);
          }
        }}
      >
        <label htmlFor="totp-code">
          To get new backup codes or turn it off, enter a code from your
          authenticator app
          <input
            id="totp-code"
            name="totp-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            disabled={pending}
          />
        </label>
        {status && (
          <p role="alert">
            <strong>{status}</strong>
          </p>
        )}
        <button
          type="submit"
          name="action"
          value="regenerate"
          disabled={pending}
        >
          Get new backup codes
        </button>{" "}
        <button type="submit" name="action" value="disable" disabled={pending}>
          {pending ? "Working…" : "Turn off"}
        </button>
      </form>
    </>
  );
}

function BackupCodes({
  codes,
  onDone,
}: {
  codes: string[];
  onDone: () => void;
}) {
  return (
    <>
      <p>
        Save these backup codes somewhere safe. Each one logs you in once if you
        lose your authenticator. They are shown only now.
      </p>
      <ul>
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onDone}>
        I saved them
      </button>
    </>
  );
}

function confirmErrorMessage(
  userError: Extract<
    ConfirmTotpEnrollmentResult,
    { success: false }
  >["userError"],
): string {
  switch (userError.error) {
    case "INVALID_CODE":
      return "That code is not valid. Check the time on your device and try the current code.";
    case "NO_PENDING_ENROLLMENT":
      return "There is no enrollment to confirm, or it expired. Start again.";
    case "NOT_SIGNED_IN":
      return "Your session has ended. Please log in again.";
    default:
      userError satisfies never;
      return `Unknown error: ${JSON.stringify(userError)}`;
  }
}

function codeErrorMessage(
  userError: Extract<
    DisableTotpResult | RegenerateBackupCodesResult,
    { success: false }
  >["userError"],
): string {
  switch (userError.error) {
    case "INVALID_CODE":
      return "That code is not valid.";
    case "RATE_LIMITED":
      return `Too many attempts. Try again in ${Math.ceil(userError.retryAfterMs / 1000)} seconds.`;
    case "NOT_ENROLLED":
      return "Two-factor authentication is already off.";
    case "NOT_SIGNED_IN":
      return "Your session has ended. Please log in again.";
    default:
      userError satisfies never;
      return `Unknown error: ${JSON.stringify(userError)}`;
  }
}
