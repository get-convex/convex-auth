import {
  useCompleteRecovery,
  useValidationStatus,
} from "@convex-dev/auth/providers/email-password/react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";

/**
 * Landing page for the password-reset link (`/reset-password?code=…`).
 * Shows the link's state, asks for the new password, and signs the user in
 * on success.
 */
export function ResetPassword() {
  const [params] = useSearchParams();
  const code = params.get("code") ?? "";
  const status = useValidationStatus(api.auth.getValidationStatus, {
    code,
    flow: "recovery",
  });
  const { completeRecovery, pending } = useCompleteRecovery(
    api.auth.completeRecovery,
  );
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  if (code === "") {
    return <p>This link is incomplete. Use the link from your email.</p>;
  }
  if (status === undefined) {
    return <p>Loading…</p>;
  }
  if (status.status === "missingSecret") {
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
  if (status.status === "invalid") {
    return (
      <>
        <h1>This link is not valid</h1>
        <p>
          The link may have expired (reset links stop working after 10 minutes)
          or already been used.{" "}
          <a href="/forgot-password">Request a new link</a>.
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
          const result = await completeRecovery({ code, newPassword });
          if (result.success) {
            navigate("/", { replace: true });
            return;
          }
          setError(() => {
            switch (result.userError.error) {
              case "INVALID_LINK":
                return "The link is not valid anymore. Request a new link.";
              case "PASSWORD_TOO_SHORT":
                return `Password must be at least ${result.userError.minimumLength} characters.`;
              case "PASSWORD_TOO_LONG":
                return `Password must be at most ${result.userError.maximumLength} characters.`;
              case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
                return "Password can't start or end with whitespace.";
              case "PASSWORD_TOO_COMMON":
                return "This password is one of the most commonly used passwords. Please choose a different one.";
              case "EMAIL_TAKEN":
                // Not produced by recovery; included for the shared union.
                return "An account already exists with that email address.";
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
        <p>
          Resetting the password for <strong>{status.email}</strong>.
        </p>
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
