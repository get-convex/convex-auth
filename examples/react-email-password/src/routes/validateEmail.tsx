import { useCompleteSignUp } from "@convex-dev/auth/providers/email-password/react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";

/**
 * Landing page for the sign-up challenge link (`/validate-email?code=…`).
 * The hook completes the validation as soon as the page opens, which also
 * signs the user in; the page shows the outcome.
 */
export function ValidateEmail() {
  const [params] = useSearchParams();
  const emailCode = params.get("code");
  if (emailCode === null) {
    return <p>This link is incomplete. Use the link from your email.</p>;
  }
  return <ValidateEmailWithCode emailCode={emailCode} />;
}

function ValidateEmailWithCode({ emailCode }: { emailCode: string }) {
  const state = useCompleteSignUp(api.auth.completeSignUp, { emailCode });

  if (state.status === "pending") {
    return <p>Validating your email…</p>;
  }
  if (state.status === "complete") {
    return (
      <>
        <h1>Email validated</h1>
        <p>
          Your email address is validated and you are signed in.{" "}
          <a href="/">Go to the dashboard</a>.
        </p>
      </>
    );
  }
  switch (state.userError.error) {
    case "MISSING_SECRET":
      return (
        <>
          <h1>Open this link in the browser you signed up from</h1>
          <p>
            For your security, the validation link only works in the browser
            where the sign-up started. Open the link there, or sign up again in
            this browser.
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
    case "EMAIL_TAKEN":
      return failed("Another account validated this email address first.");
    case "OTHER_ERROR":
      console.error("Validation failed:", state.userError.cause);
      return failed("Something went wrong. Reload the page to try again.");
    default:
      state.userError satisfies never;
      return failed("Unknown error: " + state.userError);
  }
}

function failed(message: string) {
  return (
    <>
      <h1>Could not validate your email</h1>
      <p role="alert">
        <strong>{message}</strong>
      </p>
      <p>
        <a href="/signup">Sign up again</a> to receive a new link.
      </p>
    </>
  );
}
