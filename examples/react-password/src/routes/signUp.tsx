import { useSignUpWithPassword } from "@convex-dev/auth/providers/password/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

export function SignUp() {
  const { signUp, pending } = useSignUpWithPassword(
    api.auth.signUpWithPassword,
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const result = await signUp({ username, password });
          if (result.success) {
            return;
          }
          setError(() => {
            switch (result.userError.error) {
              case "USERNAME_TAKEN":
                return "That username is already taken.";
              case "USERNAME_TOO_SHORT":
                return `Username must be at least ${result.userError.minimumLength} characters.`;
              case "USERNAME_HAS_SURROUNDING_WHITESPACE":
                return "Username can't start or end with whitespace.";
              case "USERNAME_HAS_INVALID_CHARACTERS":
                return "Username contains characters that aren't allowed.";
              case "PASSWORD_TOO_SHORT":
                return `Password must be at least ${result.userError.minimumLength} characters.`;
              case "PASSWORD_TOO_LONG":
                return `Password must be at most ${result.userError.maximumLength} characters.`;
              case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
                return "Password can't start or end with whitespace.";
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
          Username
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
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
