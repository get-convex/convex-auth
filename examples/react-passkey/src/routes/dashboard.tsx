import { useAuthActions } from "@convex-dev/auth/react";
import {
  AddPasskeyResult,
  RemovePasskeyResult,
  RenamePasskeyResult,
  useAddPasskey,
  useRemovePasskey,
} from "@convex-dev/auth/providers/passkey/react";
import { useMutation, useQuery } from "convex/react";
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
  // `listPasskeys` is a plain reactive query: the list updates live after
  // every add, rename, and remove, also from another tab.
  const listed = useQuery(api.auth.listPasskeys, {});
  const { addPasskey, pending: adding } = useAddPasskey(api.auth);
  const [error, setError] = useState<string | null>(null);

  if (listed !== undefined && !listed.success) {
    return (
      <p role="alert">
        <strong>{errorMessage(listed.userError)}</strong>
      </p>
    );
  }
  if (listed === undefined) {
    return <p>Loading your passkeys…</p>;
  }
  const passkeys = listed.passkeys;

  // A different passkey must authorize each removal, thus a user with one
  // passkey must add a second one before they can remove either.
  const canRemove = passkeys.length > 1;

  return (
    <section>
      <h2>Your passkeys</h2>
      <ul>
        {passkeys.map((passkey) => (
          <PasskeyRow
            key={passkey.passkeyId}
            passkey={passkey}
            canRemove={canRemove}
            onError={setError}
          />
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
        disabled={adding}
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
        {adding ? "Waiting for your passkey…" : "Add a passkey"}
      </button>
    </section>
  );
}

type PasskeyMetadata = Extract<
  NonNullable<ReturnType<typeof useQuery<typeof api.auth.listPasskeys>>>,
  { success: true }
>["passkeys"][number];

function PasskeyRow({
  passkey,
  canRemove,
  onError,
}: {
  passkey: PasskeyMetadata;
  canRemove: boolean;
  onError: (message: string | null) => void;
}) {
  // Each row has its own remove hook, so `pending` drives only the spinner
  // of this row.
  const { removePasskey, pending: removing } = useRemovePasskey(api.auth);
  const renamePasskey = useMutation(api.auth.renamePasskey);
  return (
    <li>
      {passkey.name ?? "Unnamed passkey"}, added{" "}
      {new Date(passkey.createdAt).toLocaleDateString()}{" "}
      <button
        onClick={async () => {
          const name = window.prompt("New name for this passkey?");
          if (name === null) {
            return;
          }
          onError(null);
          const result = await renamePasskey({
            passkeyId: passkey.passkeyId,
            name,
          });
          if (!result.success) {
            onError(errorMessage(result.userError));
          }
        }}
      >
        Rename
      </button>{" "}
      <button
        disabled={removing || !canRemove}
        onClick={async () => {
          if (!window.confirm("Remove this passkey?")) {
            return;
          }
          onError(null);
          const result = await removePasskey(passkey.passkeyId);
          if (!result.success) {
            onError(errorMessage(result.userError));
          }
        }}
      >
        {removing ? "Waiting for your passkey…" : "Remove"}
      </button>
    </li>
  );
}

function errorMessage(
  userError:
    | Extract<AddPasskeyResult, { success: false }>["userError"]
    | Extract<RemovePasskeyResult, { success: false }>["userError"]
    | Extract<RenamePasskeyResult, { success: false }>["userError"],
): string {
  switch (userError.error) {
    case "CEREMONY_ABORTED":
      // The most common failure: the user closed the passkey dialog.
      return "The passkey dialog was closed.";
    case "ALREADY_PENDING":
      // A second click while the dialog of the first is still up. The
      // first flow keeps going, so there is nothing to report.
      return "A passkey dialog is already open.";
    case "PASSKEY_ALREADY_REGISTERED":
      // The authenticator refused to make a second passkey for this
      // account.
      return "This device already has a passkey for your account.";
    case "PROTOCOL_ERROR":
      // The browser sent something that violates the protocol, or the app
      // asked for something that no correct caller asks for, such as an
      // assertion from the passkey that goes away. The Convex logs say
      // which check failed.
      return "This browser sent an invalid passkey request. Please try again, or contact support if the problem persists.";
    case "LAST_PASSKEY":
      // The Remove buttons above are already disabled in this case. The
      // server refuses the removal as well, because a user with no passkey
      // can never sign in again.
      return "You can't remove your only passkey. Add another one first.";
    case "TOO_MANY_PASSKEYS":
      // The server refuses to add a passkey beyond the per-user limit, thus
      // the user must remove one first.
      return "You have too many passkeys. Remove one before you add another.";
    case "PASSKEY_NOT_FOUND":
      // The passkey went away while the page was open, for example from
      // another tab. The reactive list catches up on its own.
      return "This passkey no longer exists.";
    case "INVALID_NAME":
      return "A passkey name must be 1 to 50 characters on one line.";
    case "CHALLENGE_EXPIRED":
      return "The passkey dialog stayed open for too long. Please try again.";
    case "UNKNOWN_CREDENTIAL":
      return "This passkey is not registered here.";
    case "NOT_SIGNED_IN":
      return "Your session has ended. Please log in again.";
    case "WEBAUTHN_UNSUPPORTED":
      return "This browser does not support passkeys.";
    case "OTHER_ERROR":
      // The mutation threw unexpectedly; the original error is available
      // on `cause` if you want to log or inspect it.
      console.error("Passkey management failed:", userError.cause);
      return "Something went wrong. Please try again.";
    default:
      userError satisfies never;
      return `Unknown error: ${JSON.stringify(userError)}`;
  }
}
