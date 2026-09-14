import {
  useCompleteSignUp,
  type CompleteSignUpClientResult,
} from "@convex-dev/auth/providers/email-password/react";
import { useConvexAuth } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";

/**
 * Landing page for the sign-up challenge link (`/validate-email?code=…`).
 * Completes the validation as soon as the page opens, which also signs the
 * user in, then shows the outcome.
 */
export function ValidateEmail() {
  const [params] = useSearchParams();
  const emailCode = params.get("code") ?? "";
  const { isLoading } = useConvexAuth();
  const { completeSignUp } = useCompleteSignUp(api.auth.completeSignUp);
  const [result, setResult] = useState<CompleteSignUpClientResult>();
  // React StrictMode runs effects twice in development. The link must be
  // presented once.
  const started = useRef(false);

  useEffect(() => {
    if (emailCode === "" || isLoading || started.current) {
      return;
    }
    started.current = true;
    void completeSignUp({ emailCode }).then(setResult);
  }, [completeSignUp, emailCode, isLoading]);

  if (emailCode === "") {
    return <p>This link is incomplete. Use the link from your email.</p>;
  }
  if (result === undefined) {
    return <p>Validating your email…</p>;
  }
  if (result.status === "complete") {
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
  switch (result.userError.error) {
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
    case "INVALID_LINK":
      return failed(
        "The link is not valid anymore. It may have expired or already been used.",
      );
    case "EMAIL_TAKEN":
      return failed("Another account validated this email address first.");
    case "OTHER_ERROR":
      console.error("Validation failed:", result.userError.cause);
      return failed("Something went wrong. Reload the page to try again.");
    default:
      result.userError satisfies never;
      return failed("Unknown error: " + result.userError);
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
