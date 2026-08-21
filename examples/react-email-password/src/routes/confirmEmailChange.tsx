import {
  useCompleteChangeEmail,
  useValidationStatus,
} from "@convex-dev/auth/providers/email-password/react";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";

/**
 * Landing page for the change-email confirmation link
 * (`/confirm-email-change?code=…`). Shows what the link will do, then
 * completes the change on confirmation. No session is minted: the user
 * already has one.
 */
export function ConfirmEmailChange() {
  const [params] = useSearchParams();
  const code = params.get("code") ?? "";
  const status = useValidationStatus(api.auth.getValidationStatus, {
    code,
    flow: "changeEmail",
  });
  const { completeChangeEmail, pending } = useCompleteChangeEmail(
    api.auth.completeChangeEmail,
  );
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (code === "") {
    return <p>This link is incomplete. Use the link from your email.</p>;
  }
  if (done) {
    return (
      <>
        <h1>Email address changed</h1>
        <p>
          <a href="/">Back to the dashboard</a>
        </p>
      </>
    );
  }
  if (status === undefined) {
    return <p>Loading…</p>;
  }
  if (status.status === "missingSecret") {
    return (
      <>
        <h1>Open this link in the browser you started from</h1>
        <p>
          For your security, the confirmation link only works in the browser
          where the email change started.
        </p>
      </>
    );
  }
  if (status.status === "invalid") {
    return (
      <>
        <h1>This link is not valid</h1>
        <p>
          The link may have expired or already been used. Start the email change
          again from the <a href="/">dashboard</a>.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Confirm your new email</h1>
      <p>
        Confirm to make <strong>{status.email}</strong> the primary address of
        your account. The old address will be removed.
      </p>
      {error ? (
        <p role="alert">
          <strong>{error}</strong>
        </p>
      ) : null}
      <button
        disabled={pending}
        onClick={async () => {
          setError(null);
          const result = await completeChangeEmail({ code });
          if (result.success) {
            setDone(true);
            return;
          }
          setError(() => {
            switch (result.userError.error) {
              case "INVALID_LINK":
                return "The link is not valid anymore. Start the change again.";
              case "EMAIL_TAKEN":
                return "Another account validated this email address first.";
              case "MISSING_SECRET":
                return "Open the link in the browser you started from.";
              case "OTHER_ERROR":
                console.error("Email change failed:", result.userError.cause);
                return "Something went wrong. Please try again.";
              default:
                result.userError satisfies never;
                return `Unknown error: ` + result.userError;
            }
          });
        }}
      >
        {pending ? "Confirming…" : "Confirm the change"}
      </button>
    </>
  );
}
