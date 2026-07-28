import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useAuthActions,
  useAuthToken,
} from "@convex-dev/auth/react";
import { useAnonymousAuth } from "@convex-dev/auth/providers/anonymous/react";
import {
  useLinkWithPassword,
  useSignInWithPassword,
} from "@convex-dev/auth/providers/password/react";
import { useQuery } from "convex/react";
import { FormEvent, useState } from "react";
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

function credentials(e: FormEvent<HTMLFormElement>) {
  const data = new FormData(e.currentTarget);
  return {
    username: data.get("username") as string,
    password: data.get("password") as string,
  };
}

function SignIn() {
  const { signInAnonymous } = useAnonymousAuth(api.auth.signInAnonymous);
  const { signIn, pending } = useSignInWithPassword(
    api.auth.signInWithPassword,
  );
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <p>You are signed out.</p>
      <button onClick={() => signInAnonymous()}>Sign in anonymously</button>
      <p>Or sign in with a username and password you linked earlier:</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const result = await signIn(credentials(e));
          setError(result.success ? null : result.userError.error);
        }}
      >
        <input name="username" placeholder="Username" required />
        <input
          name="password"
          type="password"
          placeholder="Password"
          required
        />
        <button disabled={pending}>Sign in</button>
      </form>
      {error !== null && <p>Sign-in failed: {error}</p>}
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
      {user &&
        (user.username === null ? (
          <LinkAccount />
        ) : (
          <p>
            Linked username: <strong>{user.username}</strong>
          </p>
        ))}
      <button onClick={() => signOut()}>Sign out</button>
    </>
  );
}

function LinkAccount() {
  const { link, pending } = useLinkWithPassword(api.auth.linkWithPassword);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <p>Link a username and password to this account to sign back in later:</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const result = await link(credentials(e));
          setError(result.success ? null : result.userError.error);
        }}
      >
        <input name="username" placeholder="Username" required />
        <input
          name="password"
          type="password"
          placeholder="Password"
          required
        />
        <button disabled={pending}>Link account</button>
      </form>
      {error !== null && <p>Linking failed: {error}</p>}
    </>
  );
}
