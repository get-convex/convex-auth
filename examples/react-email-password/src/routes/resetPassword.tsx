import {
  useCompleteRecovery,
  useHasChallengeSecret,
} from "@convex-dev/auth/providers/email-password/react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";

/**
 * Landing page for the password-reset link (`/reset-password?code=…`).
 * Asks for the new password, and signs the user in on success. The link is
 * verified on submit, together with the password.
 */
export function ResetPassword() {
  const [params] = useSearchParams();
  const emailCode = params.get("code") ?? "";
  const hasSecret = useHasChallengeSecret("recovery");
  const { completeRecovery, pending } = useCompleteRecovery(
    api.auth.completeRecovery,
  );
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  if (emailCode === "") {
    return <p>This link is incomplete. Use the link from your email.</p>;
  }
  if (hasSecret === undefined) {
    return <p>Loading…</p>;
  }
  if (!hasSecret) {
    return (
      <>
        <h1>Open this link in the browser you started from</h1>
        <p>
          For your security, the reset link only works in the browser where the
          reset was requested. Open the link there, or{" "}
          <a href="/forgot-password">request a new link</a> in this browser.
        </p>
      </>
    );
  }

  return (
    <>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const result = await completeRecovery({ emailCode, newPassword });
          if (result.status === "complete") {
            navigate("/", { replace: true });
            return;
          }
          setError(() => {
            switch (result.userError.error) {
              case "INVALID_CHALLENGE":
                return "This link is no longer valid. It may have expired (reset links stop working after 10 minutes) or already been used. Request a new link.";
              case "INCORRECT_CODE":
                return "This is not the latest link. Open the newest email we sent you.";
              case "PASSWORD_TOO_SHORT":
                return `Password must be at least ${result.userError.minimumLength} characters.`;
              case "PASSWORD_TOO_LONG":
                return `Password must be at most ${result.userError.maximumLength} characters.`;
              case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
                return "Password can't start or end with whitespace.";
              case "PASSWORD_TOO_COMMON":
                return "This password is one of the most commonly used passwords. Please choose a different one.";
              case "MISSING_SECRET":
                return "Open the link in the browser you started from.";
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
            disabled={pending}
          />
        </label>
        {error ? (
          <p role="alert">
            <strong>{error}</strong>
          </p>
        ) : null}
        <button type="submit" disabled={pending}>
          {pending ? "Resetting…" : "Reset password and sign in"}
        </button>
      </form>
    </>
  );
}
