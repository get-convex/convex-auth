import { useSignUpWithEmailPassword } from "@convex-dev/auth/providers/email-password/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

export function SignUp() {
  const { signUp, pending } = useSignUpWithEmailPassword(api.auth.signUp);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (sentTo !== null) {
    return (
      <>
        <h1>Validate your email</h1>
        <p>
          We sent a link to <strong>{sentTo}</strong>. Open it to validate your
          address and sign in.
        </p>
        <p>
          Open the link in <strong>this browser</strong>: the link only works in
          the browser you signed up from.
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
          const result = await signUp({ email, password });
          if (result.success) {
            setSentTo(email);
            return;
          }
          setError(() => {
            switch (result.userError.error) {
              case "INVALID_EMAIL":
                return "That email address doesn't look valid.";
              case "EMAIL_TAKEN":
                return "An account already exists with that email address.";
              case "EMAIL_NOT_FOUND":
                // Not produced by sign-up; included for the shared error union.
                return "No account exists with that email address.";
              case "RATE_LIMITED":
                return `Too many attempts. Try again in ${Math.ceil(result.userError.retryAfterMs / 1000)} seconds.`;
              case "PASSWORD_TOO_SHORT":
                return `Password must be at least ${result.userError.minimumLength} characters.`;
              case "PASSWORD_TOO_LONG":
                return `Password must be at most ${result.userError.maximumLength} characters.`;
              case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
                return "Password can't start or end with whitespace.";
              case "PASSWORD_TOO_COMMON":
                return "This password is one of the most commonly used passwords. Please choose a different one.";
              case "OTHER_ERROR":
                // The mutation threw unexpectedly; the original error is
                // available on `cause` if you want to log or inspect it.
                console.error("Sign-up failed:", result.userError.cause);
                return "Something went wrong. Please try again.";
              default:
                result.userError satisfies never;
                return `Unknown error: ` + result.userError;
            }
          });
        }}
      >
        <h1>Sign up</h1>
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
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
          {pending ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p>
        Already have an account? <a href="/login">Log in</a>
      </p>
    </>
  );
}
