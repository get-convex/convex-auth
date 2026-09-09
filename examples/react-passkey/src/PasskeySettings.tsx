import {
  useAddPasskey,
  useRemovePasskey,
} from "@convex-dev/auth/providers/passkey/react";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../convex/_generated/api";

export function PasskeySettings() {
  const query = useQuery(api.auth.listPasskeys, {});
  const { addPasskey, pending: isAdding } = useAddPasskey(api.auth);
  const { removePasskey, pending: isRemoving } = useRemovePasskey(api.auth);
  const renamePasskey = useMutation(api.auth.renamePasskey);
  const [error, setError] = useState<string | null>(null);

  // One passkey ceremony runs at a time, so every button waits for the
  // running one.
  const busy = isAdding || isRemoving;

  if (query !== undefined && !query.success) {
    query.userError.error satisfies "NOT_SIGNED_IN";
    return <p role="alert">You are not signed in.</p>;
  }
  if (query === undefined) {
    return <p>Loading your passkeys…</p>;
  }
  const passkeys = query.passkeys;

  // A different passkey must authorize each removal, thus a user with one
  // passkey must add a second one before they can remove either.
  const canRemove = passkeys.length > 1;

  return (
    <section>
      <h2>Your passkeys</h2>
      <ul>
        {passkeys.map((passkey) => (
          <li key={passkey.passkeyId}>
            <em>{passkey.name ?? "Unnamed passkey"}</em>, added{" "}
            {new Date(passkey.createdAt).toLocaleString()}{" "}
            <button
              disabled={busy}
              onClick={async () => {
                const name = window.prompt("New name for this passkey?");
                if (name === null) {
                  return;
                }
                setError(null);
                try {
                  const result = await renamePasskey({
                    passkeyId: passkey.passkeyId,
                    name,
                  });
                  if (!result.success) {
                    setError(() => {
                      switch (result.userError.error) {
                        case "INVALID_NAME":
                          return "A passkey name must be 1 to 50 characters on one line.";
                        case "PASSKEY_NOT_FOUND":
                          return "This passkey no longer exists.";
                        case "NOT_SIGNED_IN":
                          return "Your session has ended. Please log in again.";
                        default:
                          result.userError satisfies never;
                          return `Unknown error: ${JSON.stringify(result.userError)}`;
                      }
                    });
                  }
                } catch (cause) {
                  console.error("Passkey rename failed:", cause);
                  setError("Something went wrong. Please try again.");
                }
              }}
            >
              Rename
            </button>{" "}
            <button
              disabled={busy || !canRemove}
              onClick={async () => {
                if (!window.confirm("Remove this passkey?")) {
                  return;
                }
                setError(null);
                const result = await removePasskey(passkey.passkeyId);
                if (result.success) {
                  return;
                }
                setError(() => {
                  switch (result.userError.error) {
                    case "CEREMONY_ABORTED":
                      return "The passkey dialog was closed.";
                    case "ALREADY_PENDING":
                      // A second click while the first attempt still runs.
                      // That attempt keeps its passkey dialog, so there is
                      // nothing to tell the user.
                      return null;
                    case "CHALLENGE_EXPIRED":
                      return "The passkey dialog stayed open for too long. Please try again.";
                    case "UNKNOWN_CREDENTIAL":
                      return "This passkey is not registered here.";
                    case "PASSKEY_ALREADY_REGISTERED":
                      return "This device already has a passkey for your account.";
                    case "LAST_PASSKEY":
                      return "You can’t remove your only passkey. Add another one first.";
                    case "PASSKEY_NOT_FOUND":
                      return "This passkey no longer exists.";
                    case "PROTOCOL_ERROR":
                      // The browser sent something that violates the
                      // protocol. This might be caused by a misbehaving
                      // client, or by a configuration error. The Convex logs
                      // contain more information about the source of the
                      // error.
                      return "This passkey request could not be verified. Please try again, or contact support if the problem persists.";
                    case "NOT_SIGNED_IN":
                      return "Your session has ended. Please log in again.";
                    case "WEBAUTHN_UNSUPPORTED":
                      return "This browser does not support passkeys.";
                    case "OTHER_ERROR":
                      // The mutation threw unexpectedly; the original error is
                      // available on `cause` if you want to log or inspect it.
                      console.error(
                        "Passkey removal failed:",
                        result.userError.cause,
                      );
                      return "Something went wrong. Please try again.";
                    default:
                      result.userError satisfies never;
                      return `Unknown error: ${JSON.stringify(result.userError)}`;
                  }
                });
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert">
          <strong>{error}</strong>
        </p>
      ) : null}
      <button
        disabled={busy}
        onClick={async () => {
          setError(null);
          const result = await addPasskey();
          if (result.success) {
            return;
          }
          setError(() => {
            switch (result.userError.error) {
              case "CEREMONY_ABORTED":
                return "The passkey dialog was closed.";
              case "ALREADY_PENDING":
                // A second click while the first attempt still runs. That
                // attempt keeps its passkey dialog, so there is nothing to
                // tell the user.
                return null;
              case "CHALLENGE_EXPIRED":
                return "The passkey dialog stayed open for too long. Please try again.";
              case "UNKNOWN_CREDENTIAL":
                return "This passkey is not registered here.";
              case "PASSKEY_ALREADY_REGISTERED":
                return "This device already has a passkey for your account.";
              case "TOO_MANY_PASSKEYS":
                return "You have too many passkeys. Remove one before you add another.";
              case "PROTOCOL_ERROR":
                // The browser sent something that violates the protocol. This
                // might be caused by a misbehaving client, or by a
                // configuration error. The Convex logs contain more
                // information about the source of the error.
                return "This passkey request could not be verified. Please try again, or contact support if the problem persists.";
              case "NOT_SIGNED_IN":
                return "Your session has ended. Please log in again.";
              case "WEBAUTHN_UNSUPPORTED":
                return "This browser does not support passkeys.";
              case "OTHER_ERROR":
                // The mutation threw unexpectedly; the original error is
                // available on `cause` if you want to log or inspect it.
                console.error(
                  "Adding a passkey failed:",
                  result.userError.cause,
                );
                return "Something went wrong. Please try again.";
              default:
                result.userError satisfies never;
                return `Unknown error: ${JSON.stringify(result.userError)}`;
            }
          });
        }}
      >
        Add a passkey
      </button>
    </section>
  );
}
