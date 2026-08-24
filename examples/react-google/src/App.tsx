import { type ReactNode } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  useOauth,
  useSignInWithGoogle,
  type OauthFlowErrorCode,
} from "@convex-dev/auth/providers/oauth/react";
import { api } from "../convex/_generated/api";

// Map potential oauth error codes to messages.
const FLOW_ERROR_COPY: Record<OauthFlowErrorCode, string> = {
  access_denied: "Sign-in was cancelled.",
  expired: "That sign-in took too long. Please try again.",
  rejected: "Sign-in was declined.",
  oauth_error: "Something went wrong during sign-in. Please try again.",
  invalid_flow: "This sign-in can't be completed here. Please try again.",
};

/**
 * The button starts a flow and ignores what it returns. Every failure, before
 * or after the redirect, shows up in `useOauth`'s `flowError`.
 */
function SignedOut(): ReactNode {
  const { signInGoogle } = useSignInWithGoogle(api.auth);
  const { flowError } = useOauth();
  return (
    <>
      <h1>Sign in</h1>
      <p>Continue with your Google account</p>
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
        Continue with Google
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
      <p>{user?.id ?? "…"}</p>
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
