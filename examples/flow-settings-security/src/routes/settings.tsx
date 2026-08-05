import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

/**
 * Step-up plumbing shared by the sections below: when a sensitive call is
 * refused with REAUTH_REQUIRED (thrown by `startLinkOAuth`, returned in the
 * union by the mutations), the section hands us the retry and we render an
 * inline "Confirm it's you" form. `reauthWithPassword` refreshes the CURRENT
 * session's verification timestamp — no new session, no reconnect — after
 * which the retry succeeds.
 */
type StepUp = { retry: () => Promise<void> };

export function Settings() {
  const user = useQuery(api.users.currentUser);
  const { signOut } = useAuthActions();
  const [stepUp, setStepUp] = useState<StepUp | null>(null);

  const onStepUp = (retry: () => Promise<void>) => setStepUp({ retry });

  return (
    <>
      <h1>Account security</h1>
      <p>
        Signed in as <strong>{user?.email ?? "…"}</strong>{" "}
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </p>
      {stepUp !== null ? (
        <ReauthForm
          onVerified={async () => {
            const { retry } = stepUp;
            setStepUp(null);
            await retry();
          }}
          onCancel={() => setStepUp(null)}
        />
      ) : null}
      <IdentitiesSection onStepUp={onStepUp} />
      <SessionsSection />
      <PasskeysSection onStepUp={onStepUp} />
    </>
  );
}

function ReauthForm({
  onVerified,
  onCancel,
}: {
  onVerified: () => Promise<void>;
  onCancel: () => void;
}) {
  const reauthWithPassword = useAction(api.security.reauthWithPassword);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setPending(true);
        try {
          const result = await reauthWithPassword({ password });
          if (result.ok) {
            await onVerified();
          } else {
            setError(
              result.code === "RATE_LIMITED"
                ? "Too many attempts. Try again shortly."
                : "Incorrect password.",
            );
          }
        } finally {
          setPending(false);
        }
      }}
    >
      <h2>Confirm it's you</h2>
      <p>
        This action needs a recent sign-in. Verifying refreshes this session
        — it does not sign you out or start a new one.
      </p>
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
        {pending ? "Verifying…" : "Verify"}
      </button>{" "}
      <button type="button" onClick={onCancel} disabled={pending}>
        Cancel
      </button>
    </form>
  );
}

function IdentitiesSection({
  onStepUp,
}: {
  onStepUp: (retry: () => Promise<void>) => void;
}) {
  const identities = useQuery(api.security.listIdentities);
  const startLinkOAuth = useAction(api.security.startLinkOAuth);
  const unlinkIdentity = useMutation(api.security.unlinkIdentity);
  const [error, setError] = useState<string | null>(null);

  const link = async (provider: "google" | "github") => {
    setError(null);
    try {
      const { url } = await startLinkOAuth({
        provider,
        redirectTo: window.location.origin + "/callback",
      });
      window.location.href = url;
    } catch (err) {
      // startLinkOAuth THROWS on a stale session (unlike the mutations,
      // which return the error in their union): re-prove, then retry.
      if (
        err instanceof ConvexError &&
        (err.data as { code?: string }).code === "REAUTH_REQUIRED"
      ) {
        onStepUp(() => link(provider));
        return;
      }
      throw err;
    }
  };

  const unlink = async (identityId: string) => {
    setError(null);
    const result = await unlinkIdentity({ identityId });
    if (result.ok) {
      return; // The list updates reactively.
    }
    if (result.code === "REAUTH_REQUIRED") {
      onStepUp(() => unlink(identityId));
    } else if (result.code === "LAST_CREDENTIAL") {
      // The disabled button should prevent reaching this, but the server
      // refusal is the real guarantee — render it anyway.
      setError("You can't remove your only way to sign in.");
    } else {
      setError(result.message);
    }
  };

  return (
    <section>
      <h2>Linked identities</h2>
      {identities === undefined ? (
        <p>Loading…</p>
      ) : identities.length === 0 ? (
        <p>No linked identities.</p>
      ) : (
        <ul>
          {identities.map((identity) => (
            <li key={identity.id}>
              <strong>{identity.providerLabel}</strong>
              {identity.email ? (
                <>
                  {" — "}
                  {identity.email}
                  {identity.emailVerified ? " (verified)" : ""}
                </>
              ) : null}
              {" · linked "}
              {new Date(identity.linkedAt).toLocaleDateString()}{" "}
              <button
                type="button"
                disabled={identity.isLastCredential}
                title={
                  identity.isLastCredential
                    ? "This is your only way to sign in. Add another credential first."
                    : undefined
                }
                onClick={() => void unlink(identity.id)}
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert">
          <strong>{error}</strong>
        </p>
      ) : null}
      <p>
        <button type="button" onClick={() => void link("google")}>
          Link Google
        </button>{" "}
        <button type="button" onClick={() => void link("github")}>
          Link GitHub
        </button>
      </p>
    </section>
  );
}

function SessionsSection() {
  const sessions = useQuery(api.security.listSessions);
  const revokeSession = useMutation(api.security.revokeSession);
  const revokeOtherSessions = useMutation(api.security.revokeOtherSessions);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <section>
      <h2>Active sessions</h2>
      {sessions === undefined ? (
        <p>Loading…</p>
      ) : sessions.length === 0 ? (
        <p>No active sessions.</p>
      ) : (
        <ul>
          {sessions.map((session) => (
            <li key={session.id}>
              {session.device ?? "Unknown device"}
              {session.isCurrent ? (
                <>
                  {" "}
                  <em>(current)</em>
                </>
              ) : null}
              {" · last active "}
              {new Date(session.lastActiveAt).toLocaleString()}
              {!session.isCurrent ? (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={() =>
                      // That device is signed out immediately — revocation
                      // pushes to its live WebSocket; this list updates
                      // reactively too.
                      void revokeSession({ sessionId: session.id })
                    }
                  >
                    Revoke
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {notice ? <p>{notice}</p> : null}
      <p>
        <button
          type="button"
          onClick={async () => {
            setNotice(null);
            const { revoked } = await revokeOtherSessions({});
            setNotice(
              `Signed out ${revoked} other session${revoked === 1 ? "" : "s"}.`,
            );
          }}
        >
          Sign out everywhere else
        </button>
      </p>
    </section>
  );
}

function PasskeysSection({
  onStepUp,
}: {
  onStepUp: (retry: () => Promise<void>) => void;
}) {
  const passkeys = useQuery(api.security.listPasskeys);
  const addPasskey = useAction(api.security.addPasskey);
  const renamePasskey = useMutation(api.security.renamePasskey);
  const removePasskey = useMutation(api.security.removePasskey);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const add = async (passkeyName: string) => {
    setError(null);
    setPending(true);
    try {
      // In the real API this kicks off the WebAuthn ceremony (the fixture
      // collapses begin/finish into one call — see the stub's TODO).
      const result = await addPasskey({ name: passkeyName });
      if (result.ok) {
        setName("");
        return;
      }
      if (result.code === "REAUTH_REQUIRED") {
        onStepUp(() => add(passkeyName));
      } else {
        setError(result.message);
      }
    } finally {
      setPending(false);
    }
  };

  const remove = async (passkeyId: string) => {
    setError(null);
    const result = await removePasskey({ passkeyId });
    if (result.ok) {
      return; // The list updates reactively.
    }
    if (result.code === "REAUTH_REQUIRED") {
      onStepUp(() => remove(passkeyId));
    } else if (result.code === "LAST_CREDENTIAL") {
      setError("You can't remove your only way to sign in.");
    } else {
      setError(result.message);
    }
  };

  return (
    <section>
      <h2>Passkeys</h2>
      {passkeys === undefined ? (
        <p>Loading…</p>
      ) : passkeys.length === 0 ? (
        <p>No passkeys yet.</p>
      ) : (
        <ul>
          {passkeys.map((passkey) =>
            renaming !== null && renaming.id === passkey.id ? (
              <li key={passkey.id}>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await renamePasskey({
                      passkeyId: passkey.id,
                      name: renaming.name,
                    });
                    setRenaming(null);
                  }}
                >
                  <label>
                    New name
                    <input
                      type="text"
                      value={renaming.name}
                      onChange={(e) =>
                        setRenaming({ id: passkey.id, name: e.target.value })
                      }
                      required
                    />
                  </label>
                  <button type="submit">Save</button>{" "}
                  <button type="button" onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </form>
              </li>
            ) : (
              <li key={passkey.id}>
                <strong>{passkey.name}</strong>
                {" · added "}
                {new Date(passkey.createdAt).toLocaleDateString()}
                {passkey.lastUsedAt !== undefined
                  ? ` · last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`
                  : ""}{" "}
                <button
                  type="button"
                  onClick={() =>
                    setRenaming({ id: passkey.id, name: passkey.name })
                  }
                >
                  Rename
                </button>{" "}
                <button type="button" onClick={() => void remove(passkey.id)}>
                  Remove
                </button>
              </li>
            ),
          )}
        </ul>
      )}
      {error ? (
        <p role="alert">
          <strong>{error}</strong>
        </p>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add(name);
        }}
      >
        <label>
          Passkey name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Work laptop"
            required
            disabled={pending}
          />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add passkey"}
        </button>
      </form>
    </section>
  );
}
