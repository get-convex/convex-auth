import { useCompletePasswordRecovery } from "@convex-dev/auth/providers/email-password/react";
import { useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";

/**
 * Landing page for the password-reset link (`/reset-password?code=…`).
 * Asks for the new password, and signs the user in on success. The link is
 * verified on submit, together with the password.
 */
export function ResetPassword() {
  const [params] = useSearchParams();
  const emailCode = params.get("code");
  if (emailCode === null) {
    return <p>This link is incomplete. Use the link from your email.</p>;
  }
  return <ResetPasswordWithCode emailCode={emailCode} />;
}

function ResetPasswordWithCode({ emailCode }: { emailCode: string }) {
  const state = useCompletePasswordRecovery(api.auth.completePasswordRecovery, {
    emailCode,
  });
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  switch (state.status) {
    case "pending":
      return <p>Loading…</p>;
    case "complete":
      return <Navigate to="/" replace />;
    case "error":
      switch (state.userError.error) {
        case "MISSING_SECRET":
          return (
            <>
              <h1>Open this link in the browser you started from</h1>
              <p>
                For your security, the reset link only works in the browser
                where the reset was requested. Open the link there, or{" "}
                <a href="/forgot-password">request a new link</a> in this
                browser.
              </p>
            </>
          );
        case "INVALID_CHALLENGE":
          return failed(
            "This link is no longer valid. It may have expired (reset links stop working after 10 minutes) or already been used.",
          );
        case "INCORRECT_CODE":
          return failed(
            "This is not the latest link. Open the newest email we sent you.",
          );
        default:
          state.userError satisfies never;
          return failed("Unknown error: " + state.userError);
      }
    case "ready":
      break;
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const result = await state.completePasswordRecovery({ newPassword });
        if (result.status === "complete") {
          return;
        }
        setError(() => {
          switch (result.userError.error) {
            case "INVALID_CHALLENGE":
            case "INCORRECT_CODE":
              // The hook moves to its error state; the page re-renders.
              return null;
            case "PASSWORD_TOO_SHORT":
              return `Password must be at least ${result.userError.minimumLength} characters.`;
            case "PASSWORD_TOO_LONG":
              return `Password must be at most ${result.userError.maximumLength} characters.`;
            case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
              return "Password can't start or end with whitespace.";
            case "PASSWORD_TOO_COMMON":
              return "This password is one of the most commonly used passwords. Please choose a different one.";
            case "OTHER_ERROR":
              console.error("Password reset failed:", result.userError.cause);
              return "Something went wrong. Please try again.";
            default:
              result.userError satisfies never;
              return `Unknown error: ` + result.userError;
          }
        });
      }}
    >
      <h1>Choose a new password</h1>
      <label>
        New password
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          required
          disabled={state.pending}
        />
      </label>
      {error ? (
        <p role="alert">
          <strong>{error}</strong>
        </p>
      ) : null}
      <button type="submit" disabled={state.pending}>
        {state.pending ? "Resetting…" : "Reset password and sign in"}
      </button>
    </form>
  );
}

function failed(message: string) {
  return (
    <>
      <h1>Could not reset your password</h1>
      <p role="alert">
        <strong>{message}</strong>
      </p>
      <p>
        <a href="/forgot-password">Request a new link</a>.
      </p>
    </>
  );
}
