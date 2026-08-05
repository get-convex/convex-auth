import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useQuery } from "convex/react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../convex/_generated/api";

export function Upgrade() {
  const { setSession } = useAuthActions();
  const upgradeAccount = useAction(api.auth.upgradeAccount);
  const user = useQuery(api.users.currentUser);
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (user !== undefined && user !== null && !user.isAnonymous) {
    return (
      <p>
        This account is already upgraded. <Link to="/">Back to your todos</Link>
      </p>
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
            const result = await upgradeAccount({ email, password });
            switch (result.status) {
              case "complete":
                // New tokens, SAME userId: swapping sessions keeps every
                // todo the guest created.
                await setSession(result.tokens);
                navigate("/");
                return;
              case "error":
                setError(
                  result.code === "PASSWORD_TOO_SHORT"
                    ? "Password is too short."
                    : result.code === "PASSWORD_BREACHED"
                      ? "That password has appeared in a data breach. Pick another."
                      : result.code === "LINK_CONFLICT"
                        ? "An account with this email already exists. Signing " +
                          "into it would abandon your guest work — log in " +
                          "from a fresh browser instead, or use a different " +
                          "email here."
                        : result.message,
                );
                return;
              case "needs":
                // Not reachable in this fixture (email verification is
                // intentionally skipped; a stricter variant would land on
                // "verify-email" here).
                return;
              default:
                result satisfies never;
            }
          } finally {
            setPending(false);
          }
        }}
      >
        <h1>Create account</h1>
        <p>
          Your todos stay exactly where they are — this adds email + password
          to the same user.
        </p>
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
          {pending ? "Upgrading…" : "Create account"}
        </button>
      </form>
      <p>
        <Link to="/">Keep browsing as a guest</Link>
      </p>
    </>
  );
}
