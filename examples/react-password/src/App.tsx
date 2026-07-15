import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useAuthActions,
  useAuthToken,
} from "@convex-dev/auth/react";
import { FunctionReturnType } from "convex/server";
import { useAction, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../convex/_generated/api";

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
      <h1>Convex Auth — password client</h1>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <SignedOut />
      </Unauthenticated>
      <Authenticated>
        <Dashboard />
      </Authenticated>
    </main>
  );
}

type SignInResult = FunctionReturnType<typeof api.auth.signInWithPassword>;
type SignUpResult = FunctionReturnType<typeof api.auth.signUpWithPassword>;
type SignInError = Extract<SignInResult, { success: false }>["userError"];
type SignUpError = Extract<SignUpResult, { success: false }>["userError"];

function describeSignInError(userError: SignInError): string {
  switch (userError.error) {
    case "USER_NOT_FOUND":
      return "No account exists with that username.";
    case "INVALID_CREDENTIALS":
      return "Incorrect username or password.";
    case "PASSWORD_TOO_SHORT":
      return `Password must be at least ${userError.minimumLength} characters.`;
    case "PASSWORD_TOO_LONG":
      return `Password must be at most ${userError.maximumLength} characters.`;
    case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
      return "Password can't start or end with whitespace.";
    case "RATE_LIMITED":
      return `Too many attempts. Try again in ${Math.ceil(
        userError.retryAfterMs / 1000,
      )} seconds.`;
    default:
      userError satisfies never;
      return `Unknown error: ` + userError;
  }
}

function describeSignUpError(userError: SignUpError): string {
  switch (userError.error) {
    case "USERNAME_TAKEN":
      return "That username is already taken.";
    case "PASSWORD_TOO_SHORT":
      return `Password must be at least ${userError.minimumLength} characters.`;
    case "PASSWORD_TOO_LONG":
      return `Password must be at most ${userError.maximumLength} characters.`;
    case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
      return "Password can't start or end with whitespace.";
    default:
      userError satisfies never;
      return `Unknown error: ` + userError;
  }
}

function SignedOut() {
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  return (
    <>
      {mode === "signIn" ? <SignInForm /> : <SignUpForm />}
      <p style={{ fontSize: "0.9rem" }}>
        {mode === "signIn"
          ? "Don't have an account? "
          : "Already have an account? "}
        <button
          type="button"
          onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            color: "#2563eb",
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          {mode === "signIn" ? "Sign up" : "Sign in"}
        </button>
      </p>
    </>
  );
}

function SignInForm() {
  const { setSession } = useAuthActions();
  const signIn = useAction(api.auth.signInWithPassword);
  const [username, setUsername] = useState("");
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
          const result = await signIn({ username, password });
          if (result.success) {
            // Adopting the session flips <Unauthenticated> to <Authenticated>,
            // which unmounts this form.
            await setSession(result.tokens);
            return;
          }
          setError(describeSignInError(result.userError));
        } catch {
          // The action only throws for unexpected/infrastructure failures; expected
          // rejections come back as `userError` above.
          setError("Something went wrong. Please try again.");
        } finally {
          setPending(false);
        }
      }}
    >
      <h2>Sign in</h2>
      <label style={labelStyle}>
        Username
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
          disabled={pending}
          style={inputStyle}
        />
      </label>
      <label style={labelStyle}>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          disabled={pending}
          style={inputStyle}
        />
      </label>
      {error ? <ErrorMessage>{error}</ErrorMessage> : null}
      <button type="submit" disabled={pending} style={buttonStyle}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function SignUpForm() {
  const { setSession } = useAuthActions();
  const signUp = useAction(api.auth.signUpWithPassword);
  const [username, setUsername] = useState("");
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
          const result = await signUp({ username, password });
          if (result.success) {
            await setSession(result.tokens);
            return;
          }
          setError(describeSignUpError(result.userError));
        } catch {
          setError("Something went wrong. Please try again.");
        } finally {
          setPending(false);
        }
      }}
    >
      <h2>Sign up</h2>
      <label style={labelStyle}>
        Username
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
          disabled={pending}
          style={inputStyle}
        />
      </label>
      <label style={labelStyle}>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          disabled={pending}
          style={inputStyle}
        />
      </label>
      {error ? <ErrorMessage>{error}</ErrorMessage> : null}
      <button type="submit" disabled={pending} style={buttonStyle}>
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}

function ErrorMessage({ children }: { children: string }) {
  return (
    <p role="alert" style={{ color: "#dc2626", fontSize: "0.9rem" }}>
      {children}
    </p>
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
          Signed in as <strong>{user.username}</strong> ({user.id})
        </p>
      )}
      <p style={{ wordBreak: "break-all", color: "#666", fontSize: "0.8rem" }}>
        Access token: {token ? `${token.slice(0, 24)}…` : "(none)"}
      </p>
      <button onClick={() => signOut()} style={buttonStyle}>
        Sign out
      </button>
    </>
  );
}

const labelStyle = {
  display: "block",
  marginBottom: "0.75rem",
  fontSize: "0.9rem",
} as const;

const inputStyle = {
  display: "block",
  width: "100%",
  padding: "0.5rem",
  marginTop: "0.25rem",
  boxSizing: "border-box",
  fontSize: "1rem",
} as const;

const buttonStyle = {
  padding: "0.5rem 1rem",
  fontSize: "1rem",
  cursor: "pointer",
} as const;
