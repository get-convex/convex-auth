import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { redeemOAuthCode, signOut, startOAuth, useSession } from "./auth";

/**
 * The signed-in identity as the *server* sees it, i.e. from the JWT presented
 * over the WebSocket — distinct from the locally stored session, and shown to
 * prove the round trip. It reads as `none` for a moment while the connection
 * authenticates, then updates reactively.
 */
function ServerIdentity() {
  const identity = useQuery(api.users.loggedInUser);
  if (identity === undefined) {
    return <p>Server identity: loading…</p>;
  }
  if (identity === null) {
    return <p>Server identity: none (connection not yet authenticated)</p>;
  }
  return <p>Server identity: {identity.subject}</p>;
}

export function App() {
  const session = useSession();
  const [redeeming, setRedeeming] = useState(
    () => new URLSearchParams(window.location.search).get("code") !== null,
  );
  const [authError, setAuthError] = useState<string | null>(null);

  // Handle landing back from the OAuth callback: `?code` is redeemed for a
  // session, `?error` is surfaced. The ref makes this once-only under React
  // StrictMode's double-run — a one-time code can't be redeemed twice.
  const handledCallback = useRef(false);
  useEffect(() => {
    if (handledCallback.current) {
      return;
    }
    handledCallback.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");
    if (code === null && error === null) {
      return;
    }
    window.history.replaceState({}, "", window.location.pathname);
    if (error !== null) {
      setAuthError(error);
      return;
    }
    if (code !== null) {
      redeemOAuthCode(code)
        .catch((e: unknown) => {
          setAuthError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          setRedeeming(false);
        });
    }
  }, []);

  if (redeeming) {
    return <main>Signing you in…</main>;
  }

  if (session === null) {
    return (
      <main>
        <h1>Convex Auth</h1>
        {authError !== null && <p role="alert">Sign-in failed: {authError}</p>}
        <p>
          <button onClick={() => void startOAuth("google")}>
            Continue with Google
          </button>
        </p>
        <p>
          <button onClick={() => void startOAuth("github")}>
            Continue with GitHub
          </button>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Signed in</h1>
      <p>User id: {session.userId}</p>
      <ServerIdentity />
      <button onClick={() => void signOut()}>Sign out</button>
    </main>
  );
}
