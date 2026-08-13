"use client";

import { useSignUpWithPassword } from "@convex-dev/auth/providers/password/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/convex/_generated/api";

export default function SignUp() {
  // The sign-up counterpart of /signin, and likewise the provider's own hook:
  // the auth proxy creates the account server-side and mints the session the
  // same way.
  const { signUp, pending } = useSignUpWithPassword(
    api.auth.signUpWithPassword,
  );
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <main style={{ padding: 24, maxWidth: 640 }}>
      <h1>Sign up</h1>
      <form
        style={{ display: "grid", gap: 12, maxWidth: 320 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const result = await signUp({ username, password });
          if (result.success) {
            router.push("/");
            return;
          }
          setError(() => {
            switch (result.userError.error) {
              case "USERNAME_TAKEN":
                return "That username is already taken.";
              case "USERNAME_TOO_SHORT":
              case "USERNAME_HAS_SURROUNDING_WHITESPACE":
              case "USERNAME_HAS_INVALID_CHARACTERS":
                return "That username is invalid";
              case "PASSWORD_TOO_SHORT":
                return `Password must be at least ${result.userError.minimumLength} characters.`;
              case "PASSWORD_TOO_LONG":
                return `Password must be at most ${result.userError.maximumLength} characters.`;
              case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
                return "Password can't start or end with whitespace.";
              case "OTHER_ERROR":
                // The call failed unexpectedly; the original error is
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
        Already have an account? <Link href="/signin">Sign in</Link>
      </p>
    </main>
  );
}
