import { useAuthActions } from "@convex-dev/auth/react";
import {
  AddPasskeyResult,
  RemovePasskeyResult,
  usePasskeyManagement,
} from "@convex-dev/auth/providers/passkey/react";
import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

export function Dashboard() {
  const user = useQuery(api.currentUser.loggedInUser);
  const { signOut } = useAuthActions();
  return (
    <>
      {user && (
        <p>
          Signed in as <strong>{user.username}</strong> ({user.id})
        </p>
      )}
      <PasskeySettings />
      <button onClick={() => signOut()}>Sign out</button>
    </>
  );
}

function PasskeySettings() {
  const { passkeys, listError, addPasskey, removePasskey, pending } =
    usePasskeyManagement(api.auth);
  const [error, setError] = useState<string | null>(null);

  if (listError !== null) {
    return (
      <p role="alert">
        <strong>{errorMessage(listError)}</strong>
      </p>
    );
  }
  if (passkeys === undefined) {
    return <p>Loading your passkeys…</p>;
  }

  // A different passkey must authorize each removal, thus a user with one
  // passkey must add a second one before they can remove either.
  const canRemove = passkeys.length > 1;

  return (
    <section>
      <h2>Your passkeys</h2>
      <ul>
        {passkeys.map((passkey) => (
          <li key={passkey.passkeyId}>
            {passkey.name ?? "Unnamed passkey"}, added{" "}
            {new Date(passkey.createdAt).toLocaleDateString()}{" "}
            <button
              disabled={pending || !canRemove}
              onClick={async () => {
                if (!window.confirm("Remove this passkey?")) {
                  return;
                }
                setError(null);
                const result = await removePasskey(passkey.passkeyId);
                if (!result.success) {
                  setError(errorMessage(result.userError));
                }
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {canRemove ? null : (
        <p>Add a second passkey before you remove this one.</p>
      )}
      {error ? (
        <p role="alert">
          <strong>{error}</strong>
        </p>
      ) : null}
      <button
        disabled={pending}
        onClick={async () => {
          setError(null);
          // The call opens two passkey dialogs one after the other. The
          // first proves the account with a passkey the user already has.
          // The second makes the new passkey.
          const result = await addPasskey();
          if (!result.success) {
            setError(errorMessage(result.userError));
          }
        }}
      >
        {pending ? "Waiting for your passkey…" : "Add a passkey"}
      </button>
    </section>
  );
}

function errorMessage(
  userError:
    | Extract<AddPasskeyResult, { success: false }>["userError"]
    | Extract<RemovePasskeyResult, { success: false }>["userError"],
): string {
  switch (userError.error) {
    case "CEREMONY_ABORTED":
      // The most common failure: the user closed the passkey dialog.
      return "The passkey dialog was closed.";
    case "SAME_PASSKEY":
      // A passkey can't authorize its own removal, thus the user must
      // answer the dialog with a different one.
      return "Authorize this removal with a different passkey.";
    case "LAST_PASSKEY":
      // The Remove buttons above are already disabled in this case. The
      // server refuses the removal as well, because a user with no passkey
      // can never sign in again.
      return "You can't remove your only passkey. Add another one first.";
    case "TOO_MANY_PASSKEYS":
      // The server refuses to add a passkey beyond the per-user limit, thus
      // the user must remove one first.
      return "You have too many passkeys. Remove one before you add another.";
    case "NOT_SIGNED_IN":
      return "Your session has ended. Please log in again.";
    case "WEBAUTHN_UNSUPPORTED":
      return "This browser does not support passkeys.";
    case "OTHER_ERROR":
      // The mutation threw unexpectedly; the original error is available
      // on `cause` if you want to log or inspect it.
      console.error("Passkey management failed:", userError.cause);
      return "Something went wrong. Please try again.";
    case "PASSKEY_NOT_FOUND":
    case "CHALLENGE_EXPIRED":
    case "UNKNOWN_CREDENTIAL":
    case "VERIFICATION_FAILED":
      return "The passkey could not be verified. Please try again.";
    default:
      userError satisfies never;
      return `Unknown error: ${JSON.stringify(userError)}`;
  }
}
