import { type ReactNode } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  useOauth,
  useSignInWithGithub,
  useSignInWithGoogle,
} from "@convex-dev/auth/providers/oauth/react";
import { api } from "../convex/_generated/api";
import { GoogleIcon } from "./icons/GoogleIcon";
import { GitHubIcon } from "./icons/GitHubIcon";

/**
 * The sign-in screen: one button per provider plus any sign-in flow error.
 *
 * The flows the buttons kick off are fire-and-forget; failures surface
 * through `useOauth`'s `flowError`, so the rejections need no handlers here.
 */
function SignedOut(): ReactNode {
  const { signInGoogle } = useSignInWithGoogle(api.auth);
  const { signInGithub } = useSignInWithGithub(api.auth);
  const { flowError } = useOauth();
  return (
    <>
      <h1>Sign in</h1>
      <p>Continue with your preferred account</p>
      {flowError !== null && (
        <p role="alert">
          <strong>{flowError.message}</strong>
        </p>
      )}
      <button type="button" onClick={() => void signInGoogle()}>
        <GoogleIcon />
        Continue with Google
      </button>
      <button type="button" onClick={() => void signInGithub()}>
        <GitHubIcon />
        Continue with GitHub
      </button>
    </>
  );
}

/** The signed-in screen: who the server says you are, and sign-out. */
function SignedIn(): ReactNode {
  const { signOut } = useAuthActions();
  const user = useQuery(api.users.me);
  return (
    <>
      <h1>Signed in</h1>
      <p>{user?.email ?? "…"}</p>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </>
  );
}

/**
 * Landing page: sign-in options while signed out, the session's user while
 * signed in, and a brief loading state while a callback code is redeemed.
 */
export default function App(): ReactNode {
  const { isLoading, isAuthenticated } = useConvexAuth();
  return (
    <main>
      {isLoading && <p>Signing you in…</p>}
      {!isLoading && isAuthenticated && <SignedIn />}
      {!isLoading && !isAuthenticated && <SignedOut />}
    </main>
  );
}
