/**
 * React client for the `EmailPassword` provider, exported at
 * `@convex-dev/auth/providers/email-password/react`.
 *
 * @module
 */
"use client";

import { FunctionReference } from "convex/server";
import { useConvex, useMutation } from "convex/react";
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
  SignUpResult as SignUpMutationResult,
  CompleteSignUpResult,
  SignInResult as SignInMutationResult,
  StartChangeEmailResult as StartChangeEmailMutationResult,
  CompleteChangeEmailResult,
  StartPasswordRecoveryResult as StartPasswordRecoveryMutationResult,
  CompletePasswordRecoveryResult as CompletePasswordRecoveryMutationResult,
} from "./setup.ts";

/** The flows that keep a secret in the starting browser's storage. */
type EmailPasswordFlow = "signUp" | "changeEmail" | "passwordRecovery";

// One storage key per flow, so concurrent flows do not overwrite each other.
const SECRET_STORAGE_KEYS: Record<EmailPasswordFlow, string> = {
  signUp: "__convexAuthEmailPasswordSignUpSecret",
  changeEmail: "__convexAuthEmailPasswordChangeEmailSecret",
  passwordRecovery: "__convexAuthEmailPasswordRecoverySecret",
};

//------------------------------------------------------------------------------
// Result types
//------------------------------------------------------------------------------

/** The `userError` of the failure arm of a `success` envelope. */
type FailureError<Result> = Result extends {
  success: false;
  userError: infer UserError;
}
  ? UserError
  : never;

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

/**
 * The success arm of a "start" result, without the `browserSecret`. The hook
 * stores the secret itself; the caller has no use for it, and keeping it out
 * of the result keeps it out of URLs and logs.
 */
type WithoutSecret<Result> = Result extends { success: true }
  ? { success: true }
  : Result;

type SignInUnexpectedFailure = { status: "error"; userError: OtherError };

type SignUpMutation = FunctionReference<
  "mutation",
  "public",
  { email: string; password: string },
  ClientView<SignUpMutationResult>
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
  ClientView<SignInMutationResult>
>;

type StartChangeEmailMutation = FunctionReference<
  "mutation",
  "public",
  { newEmail: string; currentPassword: string },
  StartChangeEmailMutationResult
>;

type CompleteChangeEmailMutation = FunctionReference<
  "mutation",
  "public",
  { emailCode: string; browserSecret: string },
  CompleteChangeEmailResult
>;

type StartPasswordRecoveryMutation = FunctionReference<
  "mutation",
  "public",
  { email: string },
  StartPasswordRecoveryMutationResult
>;

type CompletePasswordRecoveryMutation = FunctionReference<
  "mutation",
  "public",
  { emailCode: string; browserSecret: string; newPassword: string },
  ClientView<CompletePasswordRecoveryMutationResult>
>;

/** The result of the `signIn` callback from {@link useSignInWithEmailPassword}. */
export type SignInResult =
  ClientView<SignInMutationResult> | SignInUnexpectedFailure;

/** The result of the `signUp` callback from {@link useSignUpWithEmailPassword}. */
export type SignUpResult =
  WithoutSecret<ClientView<SignUpMutationResult>> | UnexpectedFailure;

/** The result of the `startChangeEmail` callback from {@link useStartChangeEmail}. */
export type StartChangeEmailResult =
  WithoutSecret<StartChangeEmailMutationResult> | UnexpectedFailure;

/** The result of the `startPasswordRecovery` callback from {@link useStartPasswordRecovery}. */
export type StartPasswordRecoveryResult =
  WithoutSecret<StartPasswordRecoveryMutationResult> | UnexpectedFailure;

/**
 * The result of the `completePasswordRecovery` callback of the `ready` state
 * of {@link useCompletePasswordRecovery}.
 */
export type CompletePasswordRecoveryResult =
  ClientView<CompletePasswordRecoveryMutationResult> | SignInUnexpectedFailure;

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

/** The state of {@link useCompleteChangeEmail}. */
export type CompleteChangeEmailState = LinkFlowState<
  FailureError<CompleteChangeEmailResult> | MissingSecretError | OtherError
>;

/**
 * The errors of `completePasswordRecovery` that are about the link rather
 * than about the new password. They end the flow: the user needs a new link.
 */
type PasswordRecoveryLinkError = Extract<
  SignInError<ClientView<CompletePasswordRecoveryMutationResult>>,
  { error: "INVALID_CHALLENGE" | "INCORRECT_CODE" }
>;

/**
 * The state of {@link useCompletePasswordRecovery}. Unlike the other landing
 * page hooks, the flow needs input from the user (the new password) before it
 * can complete, so a `ready` state carries the function to submit it.
 */
export type CompletePasswordRecoveryState =
  | { status: "pending" }
  | {
      status: "ready";
      /**
       * Set the new password and sign the user in. Errors about the new
       * password come back in the result and leave the state `ready`, so the
       * user can try another password with the same link.
       */
      completePasswordRecovery: (args: {
        newPassword: string;
      }) => Promise<CompletePasswordRecoveryResult>;
      /** `true` while `completePasswordRecovery` is in flight. */
      pending: boolean;
    }
  | { status: "complete" }
  | {
      status: "error";
      userError: PasswordRecoveryLinkError | MissingSecretError;
    };

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
    }): Promise<SignInResult> =>
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
    }): Promise<SignUpResult> =>
      track(async () => {
        try {
          const result = await signInApi.mutation(signUpMutation, credentials);
          if (result.success) {
            await storage.set(SECRET_STORAGE_KEYS.signUp, result.browserSecret);
            return { success: true };
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

//------------------------------------------------------------------------------
// Password recovery
//------------------------------------------------------------------------------

/**
 * Client for starting a password recovery: run the backend's
 * `startPasswordRecovery` mutation and keep the returned secret for
 * {@link useCompletePasswordRecovery}.
 *
 * @param startPasswordRecoveryMutation The app's `startPasswordRecovery` mutation reference.
 */
export function useStartPasswordRecovery(
  startPasswordRecoveryMutation: StartPasswordRecoveryMutation,
) {
  const runStartPasswordRecovery = useMutation(startPasswordRecoveryMutation);
  const storage = useSecretStorage();
  const { pending, track } = usePending();

  const startPasswordRecovery = useCallback(
    async (args: { email: string }): Promise<StartPasswordRecoveryResult> =>
      track(async () => {
        try {
          const result = await runStartPasswordRecovery(args);
          if (result.success) {
            await storage.set(
              SECRET_STORAGE_KEYS.passwordRecovery,
              result.browserSecret,
            );
            return { success: true };
          }
          return result;
        } catch (cause) {
          return foldError(cause);
        }
      }),
    [runStartPasswordRecovery, storage, track],
  );

  return { startPasswordRecovery, pending };
}

/**
 * Client for the landing page of the password-reset link. As soon as the page
 * opens, it checks that this browser holds the secret stored by
 * {@link useStartPasswordRecovery}; the state is then `ready`, with the
 * function that sets the new password and adopts the minted session.
 *
 * The hook does not complete the flow by itself: the flow needs the new
 * password, so call `completePasswordRecovery` when the user submits the
 * form. An error about the password keeps the state `ready`, so show it in
 * the form. An error about the link moves the state to `error`.
 *
 * ```tsx
 * function ResetPassword({ emailCode }: { emailCode: string }) {
 *   const state = useCompletePasswordRecovery(
 *     api.auth.completePasswordRecovery,
 *     { emailCode },
 *   );
 *   const [newPassword, setNewPassword] = useState("");
 *   const [error, setError] = useState<string | null>(null);
 *
 *   switch (state.status) {
 *     case "pending":
 *       return <p>Loading…</p>;
 *     case "complete":
 *       return <Navigate to="/" replace />;
 *     case "error":
 *       // map state.userError (MISSING_SECRET, INVALID_CHALLENGE, …) to a message
 *       return <p role="alert">This link cannot be used.</p>;
 *   }
 *
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const result = await state.completePasswordRecovery({ newPassword });
 *         // map result.userError (PASSWORD_TOO_SHORT, …) to a message
 *         setError(result.status === "error" ? result.userError.error : null);
 *       }}
 *     >
 *       <label>
 *         New password
 *         <input
 *           type="password"
 *           autoComplete="new-password"
 *           required
 *           value={newPassword}
 *           onChange={(e) => setNewPassword(e.target.value)}
 *           disabled={state.pending}
 *         />
 *       </label>
 *       {error !== null && <p role="alert">{error}</p>}
 *       <button type="submit" disabled={state.pending}>
 *         Reset password and sign in
 *       </button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param completePasswordRecoveryMutation The app's `completePasswordRecovery` mutation reference.
 * @param emailCode The `code` query parameter of the link.
 */
export function useCompletePasswordRecovery(
  completePasswordRecoveryMutation: CompletePasswordRecoveryMutation,
  { emailCode }: { emailCode: string },
): CompletePasswordRecoveryState {
  const { setSession } = useAuthActions();
  const signInApi = useAuthSignInApi();
  const storage = useSecretStorage();
  const { pending, track } = usePending();
  // `undefined` while storage loads, `null` when this browser has no secret.
  const [browserSecret, setBrowserSecret] = useState<string | null | undefined>(
    undefined,
  );
  const [outcome, setOutcome] = useState<
    | { status: "complete" }
    | { status: "error"; userError: PasswordRecoveryLinkError }
    | null
  >(null);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      const secret = await storage.get(SECRET_STORAGE_KEYS.passwordRecovery);
      if (!canceled) {
        setBrowserSecret(secret ?? null);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [storage]);

  const completePasswordRecovery = useCallback(
    async ({
      newPassword,
    }: {
      newPassword: string;
    }): Promise<CompletePasswordRecoveryResult> =>
      track(async () => {
        if (typeof browserSecret !== "string") {
          // Only reachable through the `ready` state, which has the secret.
          throw new Error(
            "completePasswordRecovery was called before the flow was ready",
          );
        }
        try {
          const result = await signInApi.mutation(
            completePasswordRecoveryMutation,
            { emailCode, browserSecret, newPassword },
          );
          if (result.status === "complete") {
            await setSession(result.tokens);
            await storage.remove(SECRET_STORAGE_KEYS.passwordRecovery);
            setOutcome({ status: "complete" });
          } else if (
            result.userError.error === "INVALID_CHALLENGE" ||
            result.userError.error === "INCORRECT_CODE"
          ) {
            setOutcome({ status: "error", userError: result.userError });
          }
          return result;
        } catch (cause) {
          return foldSignInError(cause);
        }
      }),
    [
      signInApi,
      completePasswordRecoveryMutation,
      emailCode,
      browserSecret,
      storage,
      setSession,
      track,
    ],
  );

  if (outcome !== null) {
    return outcome;
  }
  if (browserSecret === undefined) {
    return { status: "pending" };
  }
  if (browserSecret === null) {
    return { status: "error", userError: { error: "MISSING_SECRET" } };
  }
  return { status: "ready", completePasswordRecovery, pending };
}

//------------------------------------------------------------------------------
// Email change
//------------------------------------------------------------------------------

/**
 * Client for starting an email change: run the backend's `startChangeEmail`
 * mutation and keep the returned secret for {@link useCompleteChangeEmail}.
 *
 * @param startChangeEmailMutation The app's `startChangeEmail` mutation reference.
 */
export function useStartChangeEmail(
  startChangeEmailMutation: StartChangeEmailMutation,
) {
  const runStartChangeEmail = useMutation(startChangeEmailMutation);
  const storage = useSecretStorage();
  const { pending, track } = usePending();

  const startChangeEmail = useCallback(
    async (args: {
      newEmail: string;
      currentPassword: string;
    }): Promise<StartChangeEmailResult> =>
      track(async () => {
        try {
          const result = await runStartChangeEmail(args);
          if (result.success) {
            await storage.set(
              SECRET_STORAGE_KEYS.changeEmail,
              result.browserSecret,
            );
            return { success: true };
          }
          return result;
        } catch (cause) {
          return foldError(cause);
        }
      }),
    [runStartChangeEmail, storage, track],
  );

  return { startChangeEmail, pending };
}

/**
 * Client for the landing page of the email-change confirmation link: as soon
 * as the page opens, present the code from the link with the secret stored by
 * {@link useStartChangeEmail}. No session is adopted: the user already has
 * one, and the backend requires it.
 *
 * @param completeChangeEmailMutation The app's `completeChangeEmail` mutation reference.
 * @param emailCode The `code` query parameter of the link.
 */
export function useCompleteChangeEmail(
  completeChangeEmailMutation: CompleteChangeEmailMutation,
  { emailCode }: { emailCode: string },
): CompleteChangeEmailState {
  const runCompleteChangeEmail = useMutation(completeChangeEmailMutation);

  const complete = useCallback(
    async (browserSecret: string) => {
      const result = await runCompleteChangeEmail({ emailCode, browserSecret });
      if (result.success) {
        return { done: true } as const;
      }
      return { done: false, userError: result.userError } as const;
    },
    [runCompleteChangeEmail, emailCode],
  );

  return useLinkFlow<FailureError<CompleteChangeEmailResult>>(
    "changeEmail",
    complete,
  );
}
