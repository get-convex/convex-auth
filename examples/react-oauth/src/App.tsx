import { type ReactNode } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  useOauth,
  useSignInWithGithub,
  useSignInWithGoogle,
  type OauthFlowErrorCode,
} from "@convex-dev/auth/providers/oauth/react";
import { api } from "../convex/_generated/api";
import { GoogleIcon } from "./icons/GoogleIcon";
import { GitHubIcon } from "./icons/GitHubIcon";

// Map potential oauth error codes to messages.
const FLOW_ERROR_COPY: Record<OauthFlowErrorCode, string> = {
  access_denied: "Sign-in was cancelled.",
  expired: "That sign-in took too long. Please try again.",
  rejected: "Sign-in was declined.",
  oauth_error: "Something went wrong during sign-in. Please try again.",
  invalid_flow: "This sign-in can't be completed here. Please try again.",
};

/**
 * Both buttons start a flow and ignore what it returns. Every failure, before
 * or after the redirect, shows up in `useOauth`'s `flowError`.
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
          <strong>
            {/**
             * flowError.message is populated from the backend if the flow is
             * rejected with a ConvexError.
             **/}
            {flowError.message ?? FLOW_ERROR_COPY[flowError.code]}
          </strong>
        </p>
      )}
      <button type="button" onClick={() => void signInGoogle().catch(() => {})}>
        <GoogleIcon />
        Continue with Google
      </button>
      <button type="button" onClick={() => void signInGithub().catch(() => {})}>
        <GitHubIcon />
        Continue with GitHub
      </button>
    </>
  );
}

function SignedIn(): ReactNode {
  const { signOut } = useAuthActions();
  const user = useQuery(api.users.getCurrentUser);
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
