import { useCompleteChangeEmail } from "@convex-dev/auth/providers/email-password/react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";

/**
 * Landing page for the change-email confirmation link
 * (`/confirm-email-change?code=…`). The hook completes the change as soon as
 * the page opens; the page shows the outcome. No session is minted: the user
 * already has one.
 */
export function ConfirmEmailChange() {
  const [params] = useSearchParams();
  const emailCode = params.get("code");
  if (emailCode === null) {
    return <p>This link is incomplete. Use the link from your email.</p>;
  }
  return <ConfirmEmailChangeWithCode emailCode={emailCode} />;
}

function ConfirmEmailChangeWithCode({ emailCode }: { emailCode: string }) {
  const state = useCompleteChangeEmail(api.auth.completeChangeEmail, {
    emailCode,
  });

  if (state.status === "pending") {
    return <p>Confirming your new email…</p>;
  }
  if (state.status === "complete") {
    return (
      <>
        <h1>Email address changed</h1>
        <p>
          The new address is now the primary address of your account.{" "}
          <a href="/">Back to the dashboard</a>.
        </p>
      </>
    );
  }
  switch (state.userError.error) {
    case "MISSING_SECRET":
      return (
        <>
          <h1>Open this link in the browser you started from</h1>
          <p>
            For your security, the confirmation link only works in the browser
            where the email change started.
          </p>
        </>
      );
    case "INVALID_CHALLENGE":
      return failed(
        "This link is no longer valid. It may have expired or already been used.",
      );
    case "INCORRECT_CODE":
      return failed(
        "This is not the latest link. Open the newest email we sent you.",
      );
    case "NOT_LOGGED_IN":
      return failed("Log in first, then open the link again.");
    case "EMAIL_TAKEN":
      return failed("Another account validated this email address first.");
    case "OTHER_ERROR":
      console.error("Email change failed:", state.userError.cause);
      return failed("Something went wrong. Reload the page to try again.");
    default:
      state.userError satisfies never;
      return failed("Unknown error: " + state.userError);
  }
}

function failed(message: string) {
  return (
    <>
      <h1>Could not change your email</h1>
      <p role="alert">
        <strong>{message}</strong>
      </p>
      <p>
        Start the email change again from the <a href="/">dashboard</a>.
      </p>
    </>
  );
}
