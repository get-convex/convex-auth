import { useContinueSignIn } from "@convex-dev/auth/react";
import { useSignInWithPassword } from "@convex-dev/auth/providers/password/react";
import { useVerifyTotpForSignIn } from "@convex-dev/auth/totp/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

/**
 * A sign-in that the backend held for a TOTP code: the password was right,
 * and the attempt token finishes it once the user verifies a code.
 */
type HeldSignIn = { attemptToken: string; expiresAt: number };

export function LogIn() {
  const [held, setHeld] = useState<HeldSignIn | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (held !== null) {
    return (
      <TotpPrompt
        held={held}
        onExpired={() => {
          setHeld(null);
          setNotice("That sign-in expired. Log in again.");
        }}
      />
    );
  }
  return <PasswordForm notice={notice} onHeld={setHeld} />;
}

function PasswordForm({
  notice,
  onHeld,
}: {
  notice: string | null;
  onHeld: (held: HeldSignIn) => void;
}) {
  const { signIn, pending } = useSignInWithPassword(
    api.auth.signInWithPassword,
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const result = await signIn({ username, password });
          if (result.status === "complete") {
            return;
          }
          if (result.status === "incomplete") {
            // The password checked out and the user has an authenticator
            // enrolled: ask for a code.
            onHeld({
              attemptToken: result.attemptToken,
              expiresAt: result.expiresAt,
            });
            return;
          }
          setError(() => {
            switch (result.userError.error) {
              case "USER_NOT_FOUND":
                return "No account exists with that username.";
              case "INVALID_CREDENTIALS":
                return "Incorrect username or password.";
              case "PASSWORD_TOO_SHORT":
                return `Password must be at least ${result.userError.minimumLength} characters.`;
              case "PASSWORD_TOO_LONG":
                return `Password must be at most ${result.userError.maximumLength} characters.`;
              case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
                return "Password can't start or end with whitespace.";
              case "RATE_LIMITED":
                return `Too many attempts. Try again in ${Math.ceil(result.userError.retryAfterMs / 1000)} seconds.`;
              case "OTHER_ERROR":
                // The mutation threw unexpectedly; the original error is
                // available on `cause` if you want to log or inspect it.
                console.error("Sign-in failed:", result.userError.cause);
                return "Something went wrong. Please try again.";
              default:
                result.userError satisfies never;
                return `Unknown error: ` + result.userError;
            }
          });
        }}
      >
        <h1>Log in</h1>
        {notice ? <p role="status">{notice}</p> : null}
        <label htmlFor="username">
          Username
          <input
            // Using a static id to help password managers behave correctly
            id="username"
            name="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            disabled={pending}
          />
        </label>
        <label htmlFor="password">
          Password
          <input
            // Using a static id to help password managers behave correctly
            id="password"
            name="password"
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
      <p>
        Don't have an account? <a href="/signup">Sign up</a>
      </p>
    </>
  );
}

function TotpPrompt({
  held,
  onExpired,
}: {
  held: HeldSignIn;
  onExpired: () => void;
}) {
  // Two steps: verify the code for the held attempt, then continue the
  // sign-in, which mints the session once the code has been verified.
  const { verify, pending: verifying } = useVerifyTotpForSignIn(
    api.auth.verifyTotpForSignIn,
  );
  const { continueSignIn, pending: continuing } = useContinueSignIn(
    api.auth.continueSignIn,
  );
  const pending = verifying || continuing;
  const [code, setCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const verified = await verify({
          attemptToken: held.attemptToken,
          code,
          kind: useBackupCode ? "backup" : "totp",
        });
        if (!verified.success) {
          switch (verified.userError.error) {
            case "SIGN_IN_EXPIRED":
              onExpired();
              return;
            case "INVALID_CODE":
              setError(
                useBackupCode
                  ? "That backup code is not valid."
                  : "That code is not valid. Check the time on your device and try the current code.",
              );
              return;
            case "RATE_LIMITED":
              setError(
                `Too many attempts. Try again in ${Math.ceil(verified.userError.retryAfterMs / 1000)} seconds.`,
              );
              return;
            case "NOT_ENROLLED":
              // The authenticator was turned off while the sign-in waited:
              // nothing is owed any more, so continue without a code.
              break;
            case "OTHER_ERROR":
              console.error(
                "Code verification failed:",
                verified.userError.cause,
              );
              setError("Something went wrong. Please try again.");
              return;
            default:
              verified.userError satisfies never;
              setError(`Unknown error: ` + verified.userError);
              return;
          }
        } else if (verified.remainingBackupCodes !== undefined) {
          console.info(
            `${verified.remainingBackupCodes} backup codes left. Regenerate them in the settings when they run low.`,
          );
        }

        const result = await continueSignIn({
          attemptToken: held.attemptToken,
        });
        if (result.status === "complete") {
          return;
        }
        if (result.status === "incomplete") {
          // Not expected here: the code was verified for this attempt.
          setError(
            `The sign-in still requires: ${result.requirements.join(", ")}.`,
          );
          return;
        }
        switch (result.userError.error) {
          case "SIGN_IN_EXPIRED":
            onExpired();
            return;
          case "OTHER_ERROR":
            console.error(
              "Continuing the sign-in failed:",
              result.userError.cause,
            );
            setError("Something went wrong. Please try again.");
            return;
          default:
            result.userError satisfies never;
            setError(`Unknown error: ` + result.userError);
        }
      }}
    >
      <h1>Enter your code</h1>
      <p>
        {useBackupCode
          ? "Enter one of the backup codes you saved when you set up your authenticator."
          : "Enter the six-digit code from your authenticator app."}
      </p>
      <label htmlFor="code">
        {useBackupCode ? "Backup code" : "Authenticator code"}
        <input
          id="code"
          name="code"
          type="text"
          inputMode={useBackupCode ? "text" : "numeric"}
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          autoFocus
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
      <p>
        <button
          type="button"
          onClick={() => {
            setUseBackupCode((value) => !value);
            setCode("");
            setError(null);
          }}
          disabled={pending}
        >
          {useBackupCode ? "Use my authenticator app" : "Use a backup code"}
        </button>{" "}
        <button type="button" onClick={onExpired} disabled={pending}>
          Start over
        </button>
      </p>
    </form>
  );
}
