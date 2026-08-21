import { useStartRecovery } from "@convex-dev/auth/providers/email-password/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

/** The `/forgot-password` page: send a password-reset link. */
export function RequestReset() {
  const { startRecovery, pending } = useStartRecovery(api.auth.startRecovery);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (sentTo !== null) {
    return (
      <>
        <h1>Check your email</h1>
        <p>
          We sent a password-reset link to <strong>{sentTo}</strong>. The link
          stops working after 10 minutes.
        </p>
        <p>
          Open the link in <strong>this browser</strong>: the link only works in
          the browser you requested it from.
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
          const result = await startRecovery({ email });
          if (result.success) {
            setSentTo(email);
            return;
          }
          setError(() => {
            switch (result.userError.error) {
              case "INVALID_EMAIL":
                return "That email address doesn't look valid.";
              case "EMAIL_NOT_FOUND":
                return "No account exists with that email address.";
              case "EMAIL_TAKEN":
                // Not produced by recovery; included for the shared union.
                return "An account already exists with that email address.";
              case "RATE_LIMITED":
                return `Too many attempts. Try again in ${Math.ceil(result.userError.retryAfterMs / 1000)} seconds.`;
              case "OTHER_ERROR":
                console.error("Reset request failed:", result.userError.cause);
                return "Something went wrong. Please try again.";
              default:
                result.userError satisfies never;
                return `Unknown error: ` + result.userError;
            }
          });
        }}
      >
        <h1>Reset your password</h1>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
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
          {pending ? "Sending…" : "Send reset link"}
        </button>
      </form>
      <p>
        Remembered your password? <a href="/login">Log in</a>
      </p>
    </>
  );
}
