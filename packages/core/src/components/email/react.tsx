/**
 * React client for the `EmailPassword` provider, exported at
 * `@convex-dev/auth/providers/email-password/react`.
 *
 * @module
 */
"use client";

import { FunctionReference } from "convex/server";
import { useConvex } from "convex/react";
import {
  useCallback,
  useRef,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ClientView } from "../../lib/types.ts";
import { AuthClientContext, useAuth } from "../../react/client.tsx";
import { useAuthActions, useAuthSignInApi } from "../../react/index.tsx";
import { NamespacedStorage, defaultStorage } from "../../browser/storage.ts";
import type {
  SignUpResult,
  CompleteSignUpResult,
  SignInResult,
} from "./setup.ts";

/** The flows that keep a secret in the starting browser's storage. */
type EmailPasswordFlow = "signUp";

// One storage key per flow, so concurrent flows do not overwrite each other.
const SECRET_STORAGE_KEYS: Record<EmailPasswordFlow, string> = {
  signUp: "__convexAuthEmailPasswordSignUpSecret",
};

//------------------------------------------------------------------------------
// Result types
//------------------------------------------------------------------------------

/** The `userError` of the error arm of a sign-in envelope. */
type SignInError<Result> = Result extends {
  status: "error";
  userError: infer UserError;
}
  ? UserError
  : never;

/**
 * The mutation threw rather than resolving to a `userError`. The thrown value
 * is preserved on `cause`.
 */
type OtherError = { error: "OTHER_ERROR"; cause: unknown };

/**
 * A link was opened in a browser that did not start the flow: the flow's
 * secret is not in this browser's storage, so completion cannot proceed. Tell
 * the user to open the link in the browser they started from.
 */
type MissingSecretError = { error: "MISSING_SECRET" };

type UnexpectedFailure = { success: false; userError: OtherError };

type SignInUnexpectedFailure = { status: "error"; userError: OtherError };

type SignUpMutation = FunctionReference<
  "mutation",
  "public",
  { email: string; password: string },
  ClientView<SignUpResult>
>;

type CompleteSignUpMutation = FunctionReference<
  "mutation",
  "public",
  { emailCode: string; browserSecret: string },
  ClientView<CompleteSignUpResult>
>;

type SignInMutation = FunctionReference<
  "mutation",
  "public",
  { email: string; password: string },
  ClientView<SignInResult>
>;

/** The result of the `signIn` callback from {@link useSignInWithEmailPassword}. */
export type SignInWithEmailPasswordResult =
  ClientView<SignInResult> | SignInUnexpectedFailure;

/** The result of the `signUp` callback from {@link useSignUpWithEmailPassword}. */
export type SignUpWithEmailPasswordResult =
  ClientView<SignUpResult> | UnexpectedFailure;

/**
 * The state of a landing page hook: `pending` until the link has been
 * presented, then `complete` or `error`.
 */
export type LinkFlowState<UserError> =
  | { status: "pending" }
  | { status: "complete" }
  | { status: "error"; userError: UserError };

/** The state of {@link useCompleteSignUp}. */
export type CompleteSignUpState = LinkFlowState<
  | SignInError<ClientView<CompleteSignUpResult>>
  | MissingSecretError
  | OtherError
>;

//------------------------------------------------------------------------------
// Shared helpers
//------------------------------------------------------------------------------

/**
 * The storage that holds the flow secrets, namespaced by deployment URL so
 * two deployments sharing one origin (dev vs prod on localhost) do not read
 * each other's secrets.
 */
function useSecretStorage(): NamespacedStorage {
  const convex = useConvex();
  return useMemo(
    () => new NamespacedStorage(defaultStorage(), convex.url),
    [convex],
  );
}

/**
 * The auth client's `withSignInPending`: while its call runs, the auth state
 * reports `isLoading` instead of signed out.
 */
function useWithSignInPending() {
  const authClient = useContext(AuthClientContext);
  if (authClient === undefined) {
    throw new Error("Must be used within a <ConvexAuthProvider>.");
  }
  return authClient.withSignInPending;
}

/**
 * Track the in-flight state of async calls. Calls can overlap, so `pending`
 * stays true until the last call ends.
 */
function usePending() {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(0);
  const track = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    inFlight.current++;
    setPending(true);
    try {
      return await work();
    } finally {
      if (--inFlight.current === 0) setPending(false);
    }
  }, []);
  return { pending, track };
}

const foldError = (cause: unknown): UnexpectedFailure => ({
  success: false,
  userError: { error: "OTHER_ERROR", cause },
});

const foldSignInError = (cause: unknown): SignInUnexpectedFailure => ({
  status: "error",
  userError: { error: "OTHER_ERROR", cause },
});

/**
 * Present a link once, as soon as the page opens: wait for the auth client to
 * load, read the flow's secret, run `complete` with it, and clear the secret
 * when the flow is done. A failed completion keeps the secret: the user may
 * have opened an older link, and the newest one must still work.
 *
 * Runs once per mounted component, so that a second run of the effect (from
 * StrictMode, or from a change to `complete`) does not present a one-shot
 * link twice.
 */
function useLinkFlow<UserError>(
  flow: EmailPasswordFlow,
  complete: (
    browserSecret: string,
  ) => Promise<{ done: true } | { done: false; userError: UserError }>,
): LinkFlowState<UserError | MissingSecretError | OtherError> {
  const { isLoading } = useAuth();
  const storage = useSecretStorage();
  const [state, setState] = useState<
    LinkFlowState<UserError | MissingSecretError | OtherError>
  >({ status: "pending" });
  const started = useRef(false);

  useEffect(() => {
    if (isLoading || started.current) {
      return;
    }
    started.current = true;
    void (async () => {
      try {
        const browserSecret = await storage.get(SECRET_STORAGE_KEYS[flow]);
        if (browserSecret === null || browserSecret === undefined) {
          setState({ status: "error", userError: { error: "MISSING_SECRET" } });
          return;
        }
        const result = await complete(browserSecret);
        if (result.done) {
          await storage.remove(SECRET_STORAGE_KEYS[flow]);
          setState({ status: "complete" });
        } else {
          setState({ status: "error", userError: result.userError });
        }
      } catch (cause) {
        setState({
          status: "error",
          userError: { error: "OTHER_ERROR", cause },
        });
      }
    })();
  }, [isLoading, storage, flow, complete]);

  return state;
}

//------------------------------------------------------------------------------
// Sign-in
//------------------------------------------------------------------------------

/**
 * Client for the sign-in flow: run the backend's `signIn` mutation and, on
 * success, establish an authenticated session.
 *
 * ```tsx
 * function LogIn() {
 *   const { signIn, pending } = useSignInWithEmailPassword(api.auth.signIn);
 *   const [email, setEmail] = useState("");
 *   const [password, setPassword] = useState("");
 *   const [error, setError] = useState<string | null>(null);
 *
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const result = await signIn({ email, password });
 *         // map result.userError (INVALID_CREDENTIALS, …) to a message
 *         setError(result.status === "error" ? result.userError.error : null);
 *       }}
 *     >
 *       <label>
 *         Email
 *         <input
 *           type="email"
 *           autoComplete="username"
 *           required
 *           value={email}
 *           onChange={(e) => setEmail(e.target.value)}
 *           disabled={pending}
 *         />
 *       </label>
 *       <label>
 *         Password
 *         <input
 *           type="password"
 *           autoComplete="current-password"
 *           required
 *           value={password}
 *           onChange={(e) => setPassword(e.target.value)}
 *           disabled={pending}
 *         />
 *       </label>
 *       {error !== null && <p role="alert">{error}</p>}
 *       <button type="submit" disabled={pending}>
 *         Log in
 *       </button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param signInMutation The app's `signIn` mutation reference.
 */
export function useSignInWithEmailPassword(signInMutation: SignInMutation) {
  const { setSession } = useAuthActions();
  const signInApi = useAuthSignInApi();
  const { pending, track } = usePending();

  const signIn = useCallback(
    async (credentials: {
      email: string;
      password: string;
    }): Promise<SignInWithEmailPasswordResult> =>
      track(async () => {
        try {
          const result = await signInApi.mutation(signInMutation, credentials);
          if (result.status === "complete") {
            await setSession(result.tokens);
          }
          return result;
        } catch (cause) {
          return foldSignInError(cause);
        }
      }),
    [signInApi, signInMutation, setSession, track],
  );

  return { signIn, pending };
}

//------------------------------------------------------------------------------
// Sign-up
//------------------------------------------------------------------------------

/**
 * Client for the sign-up flow: run the backend's `signUp` mutation and keep
 * the returned secret for {@link useCompleteSignUp}.
 *
 * A successful sign-up does *not* sign the user in: it sends the validation
 * email. Tell the user to open the link (in this same browser).
 *
 * ```tsx
 * function SignUp() {
 *   const { signUp, pending } = useSignUpWithEmailPassword(api.auth.signUp);
 *   const [email, setEmail] = useState("");
 *   const [password, setPassword] = useState("");
 *   const [error, setError] = useState<string | null>(null);
 *   const [sentTo, setSentTo] = useState<string | null>(null);
 *
 *   if (sentTo !== null) {
 *     return <p>We sent a link to {sentTo}. Open it in this browser.</p>;
 *   }
 *
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const result = await signUp({ email, password });
 *         if (result.success) {
 *           setSentTo(email);
 *         } else {
 *           // map result.userError (EMAIL_TAKEN, PASSWORD_TOO_SHORT, …) to a message
 *           setError(result.userError.error);
 *         }
 *       }}
 *     >
 *       <label>
 *         Email
 *         <input
 *           type="email"
 *           autoComplete="username"
 *           required
 *           value={email}
 *           onChange={(e) => setEmail(e.target.value)}
 *           disabled={pending}
 *         />
 *       </label>
 *       <label>
 *         Password
 *         <input
 *           type="password"
 *           autoComplete="new-password"
 *           required
 *           value={password}
 *           onChange={(e) => setPassword(e.target.value)}
 *           disabled={pending}
 *         />
 *       </label>
 *       {error !== null && <p role="alert">{error}</p>}
 *       <button type="submit" disabled={pending}>
 *         Create account
 *       </button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param signUpMutation The app's `signUp` mutation reference.
 */
export function useSignUpWithEmailPassword(signUpMutation: SignUpMutation) {
  const signInApi = useAuthSignInApi();
  const storage = useSecretStorage();
  const { pending, track } = usePending();

  const signUp = useCallback(
    async (credentials: {
      email: string;
      password: string;
    }): Promise<SignUpWithEmailPasswordResult> =>
      track(async () => {
        try {
          const result = await signInApi.mutation(signUpMutation, credentials);
          if (result.success) {
            await storage.set(SECRET_STORAGE_KEYS.signUp, result.browserSecret);
          }
          return result;
        } catch (cause) {
          return foldError(cause);
        }
      }),
    [signInApi, signUpMutation, storage, track],
  );

  return { signUp, pending };
}

/**
 * Client for the landing page of the validation link: as soon as the page
 * opens, present the code from the link with the secret stored by
 * {@link useSignUpWithEmailPassword}, and adopt the minted session.
 *
 * ```tsx
 * const state = useCompleteSignUp(api.auth.completeSignUp, { emailCode });
 * switch (state.status) {
 *   case "pending": // validating…
 *   case "complete": // signed in
 *   case "error": // map state.userError to a message
 * }
 * ```
 *
 * @param completeSignUpMutation The app's `completeSignUp` mutation reference.
 * @param emailCode The `code` query parameter of the link.
 */
export function useCompleteSignUp(
  completeSignUpMutation: CompleteSignUpMutation,
  { emailCode }: { emailCode: string },
): CompleteSignUpState {
  const { setSession } = useAuthActions();
  const signInApi = useAuthSignInApi();
  const withSignInPending = useWithSignInPending();

  // Report `isLoading` until the session is adopted, so the app does not
  // see a signed-out user while the link is validated.
  const complete = useCallback(
    (browserSecret: string) =>
      withSignInPending(async () => {
        const result = await signInApi.mutation(completeSignUpMutation, {
          emailCode,
          browserSecret,
        });
        if (result.status === "complete") {
          await setSession(result.tokens);
          return { done: true } as const;
        }
        return { done: false, userError: result.userError } as const;
      }),
    [
      signInApi,
      completeSignUpMutation,
      emailCode,
      setSession,
      withSignInPending,
    ],
  );

  return useLinkFlow<SignInError<ClientView<CompleteSignUpResult>>>(
    "signUp",
    complete,
  );
}
