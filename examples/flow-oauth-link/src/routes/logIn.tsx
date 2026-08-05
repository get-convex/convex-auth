import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

// Password sign-in is intentionally omitted; this fixture focuses on the
// OAuth leg (see flow-password-email-verify for the password treatment).
export function LogIn() {
  const startOAuth = useAction(api.auth.startOAuth);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"google" | "github" | null>(null);

  async function start(provider: "google" | "github") {
    setError(null);
    setPending(provider);
    try {
      const { url } = await startOAuth({
        provider,
        redirectTo: window.location.origin + "/callback",
      });
      // Full-page navigation to the provider. The auth HTTP callback route
      // brings us back to /callback with ?flow=<flowId>&outcome=... —
      // provider tokens never pass through the client.
      window.location.href = url;
    } catch {
      setError("Could not start sign-in. Try again.");
      setPending(null);
    }
  }

  return (
    <>
      <h1>Log in</h1>
      <p>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void start("google")}
        >
          {pending === "google" ? "Redirecting…" : "Continue with Google"}
        </button>
      </p>
      <p>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void start("github")}
        >
          {pending === "github" ? "Redirecting…" : "Continue with GitHub"}
        </button>
      </p>
      {error ? (
        <p role="alert">
          <strong>{error}</strong>
        </p>
      ) : null}
    </>
  );
}
