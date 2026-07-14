import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useAuthActions,
  useAuthToken,
} from "@convex-dev/auth/react";
import { useAnonymousAuth } from "@convex-dev/auth/providers/anonymous/react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

/**
 * A minimal end-to-end exercise of the core client: anonymous sign-in →
 * `setSession` → an authenticated query → sign-out. The `Authenticated` /
 * `Unauthenticated` / `AuthLoading` components read Convex's validated auth
 * state (from the JWT handshake), so what they render confirms the whole loop.
 *
 * Sign-in goes through the anonymous provider's client (`useAnonymousAuth`),
 * which wraps that provider's `signInAnonymous` → `setSession` wiring.
 */
export function App() {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 480,
        margin: "4rem auto",
        padding: "0 1rem",
        lineHeight: 1.5,
      }}
    >
      <h1>Convex Auth — minimal client</h1>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <Dashboard />
      </Authenticated>
    </main>
  );
}

function SignIn() {
  const { signInAnonymous } = useAnonymousAuth(api.auth.signInAnonymous);
  return (
    <>
      <p>You are signed out.</p>
      <button onClick={() => signInAnonymous()}>Sign in anonymously</button>
    </>
  );
}

function Dashboard() {
  const user = useQuery(api.users.loggedInUser);
  const token = useAuthToken();
  const { signOut } = useAuthActions();
  return (
    <>
      {user && (
        <p>
          Signed in as <strong>{user.name}</strong> ({user.id})
        </p>
      )}

      <p
        style={{
          wordBreak: "break-all",
          color: "#666",
          fontSize: "0.8rem",
        }}
      >
        Access token: {token ? `${token.slice(0, 24)}…` : "(none)"}
      </p>
      <button onClick={() => signOut()}>Sign out</button>
    </>
  );
}
