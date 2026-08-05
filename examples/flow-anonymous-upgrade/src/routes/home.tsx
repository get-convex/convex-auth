import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useAuthActions,
} from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";

export function Home() {
  return (
    <>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <AutoSignIn />
      </Unauthenticated>
      <Authenticated>
        <Todos />
      </Authenticated>
    </>
  );
}

/**
 * No login screen: an unauthenticated visitor is signed in anonymously the
 * moment they arrive. The button-less useEffect is the whole "sign-up" UX.
 */
function AutoSignIn() {
  const { setSession } = useAuthActions();
  const signInAnonymously = useMutation(api.auth.signInAnonymously);
  const [error, setError] = useState<string | null>(null);
  // Guard against React StrictMode's double-invoked effects creating two
  // guest users.
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) {
      return;
    }
    fired.current = true;
    void (async () => {
      const result = await signInAnonymously({});
      switch (result.status) {
        case "complete":
          // A real user + real session; todos created now survive reloads.
          await setSession(result.tokens);
          return;
        case "error":
          setError(
            result.code === "RATE_LIMITED"
              ? "Too many new sessions from here. Try again shortly."
              : result.message,
          );
          return;
        case "needs":
          return; // Not reachable in this flow.
        default:
          result satisfies never;
      }
    })();
  }, [signInAnonymously, setSession]);

  return error ? (
    <p role="alert">
      <strong>{error}</strong>
    </p>
  ) : (
    <p>Setting up your guest session…</p>
  );
}

function Todos() {
  const user = useQuery(api.users.currentUser);
  const todos = useQuery(api.todos.list);
  const addTodo = useMutation(api.todos.add);
  const { signOut } = useAuthActions();
  const [text, setText] = useState("");

  return (
    <>
      <h1>Todos</h1>
      {user?.isAnonymous ? (
        <p>
          You're browsing as a guest —{" "}
          <Link to="/upgrade">Create an account</Link> to keep your work.
        </p>
      ) : null}
      <p>
        Signed in as <strong>{user?.email ?? "guest"}</strong> (user id:{" "}
        <code>{user?.id ?? "…"}</code>
        {/* Note this id before upgrading: it must not change after. */})
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (text.trim() === "") {
            return;
          }
          await addTodo({ text: text.trim() });
          setText("");
        }}
      >
        <label>
          New todo
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button type="submit">Add</button>
      </form>
      <ul>
        {(todos ?? []).map((todo) => (
          <li key={todo._id}>{todo.text}</li>
        ))}
      </ul>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </>
  );
}
