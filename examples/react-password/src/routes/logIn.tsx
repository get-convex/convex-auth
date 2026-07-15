import { useAuthActions } from "@convex-dev/auth/react";
import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

export function LogIn() {
  const { setSession } = useAuthActions();
  const signIn = useAction(api.auth.signInWithPassword);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setPending(true);
          try {
            const result = await signIn({ username, password });
            if (result.success) {
              await setSession(result.tokens);
              return;
            }
            setError(() => {
              switch (result.userError.error) {
                case "USER_NOT_FOUND":
                  return "No account exists with that username.";
                case "INVALID_CREDENTIALS":
                  return "Incorrect username or password.";
                case "PASSWORD_TOO_SHORT":
                  return `Password must be at least ${result.userError.minimumLength} characters.`;
                case "PASSWORD_TOO_LONG":
                  return `Password must be at most ${result.userError.maximumLength} characters.`;
                case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
                  return "Password can't start or end with whitespace.";
                case "RATE_LIMITED":
                  return `Too many attempts. Try again in ${Math.ceil(result.userError.retryAfterMs / 1000)} seconds.`;
                default:
                  result.userError satisfies never;
                  return `Unknown error: ` + result.userError;
              }
            });
          } catch {
            setError("Something went wrong. Please try again.");
          } finally {
            setPending(false);
          }
        }}
      >
        <h1>Log in</h1>
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
            autoComplete="current-password"
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
          {pending ? "Logging in…" : "Log in"}
        </button>
      </form>
      <p>
        Don't have an account? <a href="/signup">Sign up</a>
      </p>
    </>
  );
}
