import { useAuthActions } from "@convex-dev/auth/react";
import { useChangePassword } from "@convex-dev/auth/providers/email-password/react";
import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

export function Dashboard() {
  const user = useQuery(api.currentUser.loggedInUser);
  const { signOut } = useAuthActions();
  return (
    <>
      {user && (
        <>
          <p>
            Signed in as{" "}
            <strong>
              {user.emails.find((entry) => entry.isPrimary)?.email}
            </strong>{" "}
            ({user.id})
          </p>
          <h2>Your email addresses</h2>
          <ul>
            {user.emails.map((entry) => (
              <li key={entry.email}>
                {entry.email}
                {entry.isPrimary ? <strong> (primary)</strong> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <ChangePasswordForm />
      <h2>Session</h2>
      <button onClick={() => signOut()}>Sign out</button>
    </>
  );
}

function ChangePasswordForm() {
  const { changePassword, pending } = useChangePassword(
    api.auth.changePassword,
  );
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setMessage(null);
        const result = await changePassword({ currentPassword, newPassword });
        if (result.success) {
          setCurrentPassword("");
          setNewPassword("");
          setMessage("Your password was changed.");
          return;
        }
        setMessage(() => {
          switch (result.userError.error) {
            case "NOT_LOGGED_IN":
              return "You are not logged in.";
            case "INVALID_CREDENTIALS":
              return "The current password is incorrect.";
            case "PASSWORD_TOO_SHORT":
              return `Password must be at least ${result.userError.minimumLength} characters.`;
            case "PASSWORD_TOO_LONG":
              return `Password must be at most ${result.userError.maximumLength} characters.`;
            case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
              return "Password can't start or end with whitespace.";
            case "PASSWORD_TOO_COMMON":
              return "This password is one of the most commonly used passwords. Please choose a different one.";
            case "RATE_LIMITED":
              return `Too many attempts. Try again in ${Math.ceil(result.userError.retryAfterMs / 1000)} seconds.`;
            case "OTHER_ERROR":
              console.error("Change password failed:", result.userError.cause);
              return "Something went wrong. Please try again.";
            default:
              result.userError satisfies never;
              return `Unknown error: ` + result.userError;
          }
        });
      }}
    >
      <h2>Change password</h2>
      <label>
        Current password
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          required
          disabled={pending}
        />
      </label>
      <label>
        New password
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          required
          disabled={pending}
        />
      </label>
      {message ? (
        <p role="alert">
          <strong>{message}</strong>
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}
