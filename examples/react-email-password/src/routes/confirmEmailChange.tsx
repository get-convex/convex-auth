import {
  useCompleteChangeEmail,
  type CompleteChangeEmailClientResult,
} from "@convex-dev/auth/providers/email-password/react";
import { useConvexAuth } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";

/**
 * Landing page for the change-email confirmation link
 * (`/confirm-email-change?code=…`). Completes the change as soon as the
 * page opens, then shows the outcome. No session is minted: the user
 * already has one.
 */
export function ConfirmEmailChange() {
  const [params] = useSearchParams();
  const emailCode = params.get("code") ?? "";
  const { isLoading } = useConvexAuth();
  const { completeChangeEmail } = useCompleteChangeEmail(
    api.auth.completeChangeEmail,
  );
  const [result, setResult] = useState<CompleteChangeEmailClientResult>();
  // React StrictMode runs effects twice in development. The link must be
  // presented once.
  const started = useRef(false);

  useEffect(() => {
    // Wait for the session to load: the change needs the signed-in user.
    if (emailCode === "" || isLoading || started.current) {
      return;
    }
    started.current = true;
    void completeChangeEmail({ emailCode }).then(setResult);
  }, [completeChangeEmail, emailCode, isLoading]);

  if (emailCode === "") {
    return <p>This link is incomplete. Use the link from your email.</p>;
  }
  if (result === undefined) {
    return <p>Confirming your new email…</p>;
  }
  if (result.success) {
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
  switch (result.userError.error) {
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
    case "INVALID_LINK":
      return failed(
        "The link is not valid anymore. It may have expired or already been used.",
      );
    case "NOT_LOGGED_IN":
      return failed("Log in first, then open the link again.");
    case "EMAIL_TAKEN":
      return failed("Another account validated this email address first.");
    case "OTHER_ERROR":
      console.error("Email change failed:", result.userError.cause);
      return failed("Something went wrong. Reload the page to try again.");
    default:
      result.userError satisfies never;
      return failed("Unknown error: " + result.userError);
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
