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
import "./index.css";

export function App() {
  return (
    <main>
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
  const user = useQuery(api.currentUser.loggedInUser);
  const token = useAuthToken();
  const { signOut } = useAuthActions();
  return (
    <>
      <p>
        Signed in as <strong>{user ? user.id : "…"}</strong>
      </p>
      <p>Access token: {token ? `${token.slice(0, 24)}…` : "(none)"}</p>
      <button onClick={() => signOut()}>Sign out</button>
    </>
  );
}
