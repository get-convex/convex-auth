import {
  useCompleteSignUp,
  useValidationStatus,
} from "@convex-dev/auth/providers/email-password/react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";

/**
 * Landing page for the sign-up validation link
 * (`/validate-email?code=…`). Shows what the link will do, then completes
 * the validation — which also signs the user in — on confirmation.
 */
export function ValidateEmail() {
  const [params] = useSearchParams();
  const code = params.get("code") ?? "";
  const status = useValidationStatus(api.auth.getValidationStatus, {
    code,
    flow: "signUp",
  });
  const { completeSignUp, pending } = useCompleteSignUp(
    api.auth.completeSignUp,
  );
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
        <h1>Open this link in the browser you signed up from</h1>
        <p>
          For your security, the validation link only works in the browser where
          the sign-up started. Open the link there, or sign up again in this
          browser.
        </p>
      </>
    );
  }
  if (status.status === "invalid") {
    return (
      <>
        <h1>This link is not valid</h1>
        <p>
          The link may have expired or already been used.{" "}
          <a href="/signup">Sign up again</a> to receive a new link.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Validate your email</h1>
      <p>
        Confirm to validate <strong>{status.email}</strong> and sign in.
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
          const result = await completeSignUp({ code });
          if (result.success) {
            navigate("/", { replace: true });
            return;
          }
          setError(() => {
            switch (result.userError.error) {
              case "INVALID_LINK":
                return "The link is not valid anymore. Sign up again to receive a new link.";
              case "EMAIL_TAKEN":
                return "Another account validated this email address first.";
              case "MISSING_SECRET":
                return "Open the link in the browser you signed up from.";
              case "OTHER_ERROR":
                console.error("Validation failed:", result.userError.cause);
                return "Something went wrong. Please try again.";
              default:
                result.userError satisfies never;
                return `Unknown error: ` + result.userError;
            }
          });
        }}
      >
        {pending ? "Validating…" : "Validate and sign in"}
      </button>
    </>
  );
}
