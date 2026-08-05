import { useAuthActions } from "@convex-dev/auth/react";
import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

export function LogIn() {
  const { setSession } = useAuthActions();
  const signIn = useAction(api.auth.signIn);
  const verifyEmail = useAction(api.auth.verifyEmail);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  // Sign-in can bounce into email verification (e.g. an account whose email
  // was never verified): same union, same handling as sign-up.
  const [verifyFlowId, setVerifyFlowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (verifyFlowId !== null) {
    return (
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const result = await verifyEmail({ flowId: verifyFlowId, code });
          if (result.status === "complete") {
            await setSession(result.tokens);
          } else if (result.status === "error") {
            setError(
              result.code === "CODE_INVALID"
                ? "Incorrect code."
                : "That code expired or the flow timed out. Log in again.",
            );
          }
        }}
      >
        <h1>Verify your email</h1>
        <p>Your email was never verified. We just sent you a code.</p>
        <label>
          Code
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
        </label>
        {error ? (
          <p role="alert">
            <strong>{error}</strong>
          </p>
        ) : null}
        <button type="submit">Verify and log in</button>
      </form>
    );
  }

  return (
    <>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setPending(true);
          try {
            const result = await signIn({ email, password });
            switch (result.status) {
              case "complete":
                await setSession(result.tokens);
                return;
              case "needs":
                setVerifyFlowId(result.flowId);
                return;
              case "error":
                setError(
                  result.code === "RATE_LIMITED"
                    ? "Too many attempts. Try again shortly."
                    : "Incorrect email or password.",
                );
                return;
              default:
                result satisfies never;
            }
          } finally {
            setPending(false);
          }
        }}
      >
        <h1>Log in</h1>
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
