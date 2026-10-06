"use client";

import { useConvexAuth } from "@convex-dev/auth/nextjs";
import { useAnonymousAuth } from "@convex-dev/auth/providers/anonymous/react";
import {
  useOauth,
  useSignInWithGithub,
  type OauthFlowErrorCode,
} from "@convex-dev/auth/providers/oauth/react";
import { useSignInWithPassword } from "@convex-dev/auth/providers/password/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";

// Map potential oauth error codes to messages.
const FLOW_ERROR_COPY: Record<OauthFlowErrorCode, string> = {
  access_denied: "Sign-in was cancelled.",
  expired: "That sign-in took too long. Please try again.",
  rejected: "Sign-in was declined.",
  oauth_error: "Something went wrong during sign-in. Please try again.",
  invalid_flow: "This sign-in can't be completed here. Please try again.",
};

export default function SignIn() {
  // The provider's own hook, with no SSR-specific variant. The surrounding
  // ConvexAuthNextjsProvider routes this call through the sign-in route, which
  // moves the minted refresh token into an httpOnly cookie so it never reaches
  // JS. Both functions are listed in `signIn` in src/lib/serverAuth.ts.
  const { signIn, pending } = useSignInWithPassword(
    api.auth.signInWithPassword,
  );
  const { signInAnonymous } = useAnonymousAuth(api.auth.signInAnonymous);
  // GitHub sends the user back to this page, where the hook redeems the
  // callback code through the sign-in route. Every failure, before or after
  // the redirect, shows up in `flowError`.
  const { signInGithub } = useSignInWithGithub(api.auth);
  const { flowError } = useOauth();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const router = useRouter();
  // The GitHub sign-in finishes on this page with no submit handler to
  // navigate, so go home once the session is in place.
  useEffect(() => {
    if (isAuthenticated) router.replace("/");
  }, [isAuthenticated, router]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <main style={{ padding: 24, maxWidth: 640 }}>
      <h1>Sign in</h1>
      <form
        style={{ display: "grid", gap: 12, maxWidth: 320 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const result = await signIn({ username, password });
          if (result.status === "complete") {
            router.push("/");
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
              case "OTHER_ERROR":
                // The call failed unexpectedly; the original error is
                // available on `cause` if you want to log or inspect it.
                console.error("Sign-in failed:", result.userError.cause);
                return "Something went wrong. Please try again.";
              default:
                result.userError satisfies never;
                return `Unknown error: ` + result.userError;
            }
          });
        }}
      >
        <label htmlFor="username">
          Username
          <input
            // Using a static id to help password managers behave correctly
            id="username"
            name="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            disabled={pending}
          />
        </label>
        <label htmlFor="password">
          Password
          <input
            // Using a static id to help password managers behave correctly
            id="password"
            name="password"
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
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p>
        Don't have an account? <Link href="/signup">Sign up</Link>
      </p>
      {flowError !== null && (
        <p role="alert">
          <strong>
            {/**
             * flowError.message is populated from the backend if the flow is
             * rejected with a ConvexError.
             **/}
            {flowError.message ?? FLOW_ERROR_COPY[flowError.code]}
          </strong>
        </p>
      )}
      <p>
        <button
          type="button"
          disabled={pending || isLoading}
          onClick={() => void signInGithub().catch(() => {})}
        >
          Continue with GitHub
        </button>
      </p>
      <p>
        Or skip the account:{" "}
        <button
          disabled={pending}
          onClick={async () => {
            await signInAnonymous();
            router.push("/");
          }}
        >
          Sign in anonymously
        </button>
      </p>
    </main>
  );
}
