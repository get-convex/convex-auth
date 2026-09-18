import { usePendingSignIn } from "@convex-dev/auth/react";
import { useSignInWithPassword } from "@convex-dev/auth/providers/password/react";
import {
  TOTP_REQUIREMENT,
  useTotpSignInStep,
} from "@convex-dev/auth/totp/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

export function LogIn() {
  // Set once the password checks out for a user with an authenticator
  // enrolled: the sign-in waits for a code before it grants a session.
  const { pendingSignIn, expired, cancel } = usePendingSignIn();

  if (pendingSignIn !== null) {
    if (pendingSignIn.requirements.includes(TOTP_REQUIREMENT)) {
      return <TotpPrompt onStartOver={cancel} />;
    }
    // Only TOTP is configured in convex/auth.ts, so this is for a
    // requirement this page has no step for.
    return (
      <>
        <p role="alert">
          This sign-in needs a step this page can't show:{" "}
          {pendingSignIn.requirements.join(", ")}.
        </p>
        <button type="button" onClick={cancel}>
          Start over
        </button>
      </>
    );
  }
  return (
    <PasswordForm
      notice={expired ? "That sign-in expired. Log in again." : null}
    />
  );
}

function PasswordForm({ notice }: { notice: string | null }) {
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
          // On "incomplete", LogIn's usePendingSignIn now shows the code prompt.
          if (result.status !== "error") {
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

function TotpPrompt({ onStartOver }: { onStartOver: () => void }) {
  const { submit, pending } = useTotpSignInStep({
    verifyTotpForSignIn: api.auth.verifyTotpForSignIn,
    continueSignIn: api.auth.continueSignIn,
  });
  const [code, setCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const result = await submit({
          code,
          kind: useBackupCode ? "backup" : "totp",
        });
        if (result.status !== "error") {
          // "complete" signs the user in; "incomplete" names another step,
          // which LogIn renders from usePendingSignIn.
          if (result.remainingBackupCodes !== undefined) {
            console.info(
              `${result.remainingBackupCodes} backup codes left. Regenerate them in the settings when they run low.`,
            );
          }
          return;
        }
        switch (result.userError.error) {
          case "SIGN_IN_EXPIRED":
            // LogIn goes back to the password form with a notice.
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
              `Too many attempts. Try again in ${Math.ceil(result.userError.retryAfterMs / 1000)} seconds.`,
            );
            return;
          case "OTHER_ERROR":
            console.error("Code verification failed:", result.userError.cause);
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
        <button type="button" onClick={onStartOver} disabled={pending}>
          Start over
        </button>
      </p>
    </form>
  );
}
