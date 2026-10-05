/**
 * React client for the `EmailPassword` provider, exported at
 * `@convex-dev/auth/providers/email-password/react`.
 *
 * @module
 */
"use client";

import { FunctionReference, getFunctionName } from "convex/server";
import { useConvex, useMutation, useQuery } from "convex/react";
import { useCallback, useRef, useEffect, useMemo, useState } from "react";
import type { ClientView } from "../../lib/types.ts";
import { useAuth } from "../../react/client.tsx";
import { useAuthClient } from "../../react/index.tsx";
import type { SignInStorage } from "../../browser/storage.ts";
import type {
  SignUpResult as SignUpMutationResult,
  CompleteSignUpResult,
  SignInResult as SignInMutationResult,
  StartChangeEmailResult as StartChangeEmailMutationResult,
  CompleteChangeEmailResult,
  StartPasswordRecoveryResult as StartPasswordRecoveryMutationResult,
  CheckPasswordRecoveryResult as CheckPasswordRecoveryQueryResult,
  CompletePasswordRecoveryResult as CompletePasswordRecoveryMutationResult,
} from "./setup.ts";

/**
 * The flows that the user completes with a link from an email. Each flow keeps
 * a secret in the storage of the browser that started it.
 */
type EmailLinkFlow = "signUp" | "changeEmail" | "passwordRecovery";

// Each flow type has one key in the `"email"` sign-in storage, so flows of
// different types can run at the same time. A second flow of one type
// replaces the secret of the first.
const SECRET_STORAGE_KEYS: Record<EmailLinkFlow, string> = {
  signUp: "signUpSecret",
  changeEmail: "changeEmailSecret",
  passwordRecovery: "passwordRecoverySecret",
};

//------------------------------------------------------------------------------
// Result types
//------------------------------------------------------------------------------

/** The `userError` of the failure arm of a `success` envelope. */
type ExtractError<Result> = Result extends {
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
  ? Omit<Result, "browserSecret">
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

type CheckPasswordRecoveryQuery = FunctionReference<
  "query",
  "public",
  { emailCode: string; browserSecret: string },
  CheckPasswordRecoveryQueryResult
>;

type CompletePasswordRecoveryMutation = FunctionReference<
  "mutation",
  "public",
  { emailCode: string; browserSecret: string; newPassword: string },
  ClientView<CompletePasswordRecoveryMutationResult>
>;

/**
 * The functions that {@link useCompletePasswordRecovery} calls. The app's
 * `api.auth` has both of them.
 */
export type PasswordRecoveryApi = {
  checkPasswordRecovery: CheckPasswordRecoveryQuery;
  completePasswordRecovery: CompletePasswordRecoveryMutation;
};

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
 * The state of a landing page hook: `loading` until the link has been
 * presented, then `complete` or `error`.
 */
export type LinkFlowState<UserError> =
  | { status: "loading" }
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
  ExtractError<CompleteChangeEmailResult> | MissingSecretError | OtherError
>;

/**
 * The errors about the link rather than about the new password: the errors
 * of `checkPasswordRecovery`. They end the flow: the user needs a new link.
 */
type PasswordRecoveryLinkError = ExtractError<CheckPasswordRecoveryQueryResult>;

// One key for each link error. Thus a new error in the result of
// `checkPasswordRecovery` is a compile error here.
const PASSWORD_RECOVERY_LINK_ERRORS: Record<
  PasswordRecoveryLinkError["error"],
  true
> = { INVALID_CHALLENGE: true, INCORRECT_CODE: true };

function isPasswordRecoveryLinkError(
  userError: SignInError<ClientView<CompletePasswordRecoveryMutationResult>>,
): userError is PasswordRecoveryLinkError {
  return userError.error in PASSWORD_RECOVERY_LINK_ERRORS;
}

/**
 * The state of {@link useCompletePasswordRecovery}. Unlike the other landing
 * page hooks, the flow needs input from the user (the new password) before it
 * can complete, so a `ready` state carries the function to submit it.
 */
export type CompletePasswordRecoveryState =
  | { status: "loading" }
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
 * The storage that holds the flow secrets. It is the auth client's `"email"`
 * sign-in storage, so it uses the app's storage and namespace.
 */
function useSecretStorage(): SignInStorage {
  const auth = useAuthClient();
  // `signInStorage` returns a new object per call, and effects depend on it.
  return useMemo(() => auth.signInStorage("email"), [auth]);
}

/**
 * The auth client's `withSignInPending`. While its call runs, the auth state
 * reports `isLoading` instead of signed out.
 */
function useWithSignInPending() {
  return useAuthClient().withSignInPending;
}

/**
 * Track the in-flight state of async calls.
 */
function usePending() {
  const [pending, setPending] = useState(false);

  // We count the number of pending calls out of safety.
  // Normally apps shouldn’t start concurrent flows (e.g. they should disable
  // form submission when a current submission is ongoing), this is just a layer
  // of extra safey in case they don’t do it correctly.
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
 * Present a link once, as soon as the page opens. It reads the flow's secret,
 * runs `complete` with it, and removes the secret when the flow is done. A
 * failed completion leaves the secret in storage, because the user may have
 * opened an older link and the newest one must work.
 *
 * It runs on mount without a user action, which is safe because the browser
 * secret proves that this browser started the flow.
 *
 * With `signsIn: true`, the mount effect runs the flow in
 * `withSignInPending` before the auth client loads, so the auth state reports
 * `isLoading` until the new session is stored. With `signsIn: false`, the
 * flow waits until the auth client loads, so the Convex client sends the
 * user's token before the mutation.
 */
function useLinkFlow<UserError>(
  flow: EmailLinkFlow,
  complete: (
    browserSecret: string,
  ) => Promise<{ done: true } | { done: false; userError: UserError }>,
  { signsIn }: { signsIn: boolean },
): LinkFlowState<UserError | MissingSecretError | OtherError> {
  const { isLoading } = useAuth();
  const withSignInPending = useWithSignInPending();
  const storage = useSecretStorage();
  const [state, setState] = useState<
    LinkFlowState<UserError | MissingSecretError | OtherError>
  >({ status: "loading" });

  // StrictMode runs the mount effect twice, and the flow must run once.
  const started = useRef(false);
  const waitsForAuth = !signsIn && isLoading;

  useEffect(() => {
    if (waitsForAuth || started.current) {
      return;
    }
    started.current = true;
    const run = async () => {
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
    };
    // The pending count goes up here, before any await, so the auth state
    // never reports signed out before the session is stored.
    void (signsIn ? withSignInPending(run) : run());
  }, [waitsForAuth, storage, flow, complete, signsIn, withSignInPending]);

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
  const auth = useAuthClient();
  const { pending, track } = usePending();

  const signIn = useCallback(
    async (credentials: {
      email: string;
      password: string;
    }): Promise<SignInResult> =>
      track(async () => {
        try {
          const result = await auth.signIn.mutation(
            signInMutation,
            credentials,
          );
          if (result.status === "complete") {
            await auth.setSession(result.tokens);
          }
          return result;
        } catch (cause) {
          return foldSignInError(cause);
        }
      }),
    [auth, signInMutation, track],
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
  const convex = useConvex();
  const storage = useSecretStorage();
  const { pending, track } = usePending();

  const signUp = useCallback(
    async (credentials: {
      email: string;
      password: string;
    }): Promise<SignUpResult> =>
      track(async () => {
        try {
          // The result has no sign-in envelope, so it runs on the Convex client.
          const result = await convex.mutation(signUpMutation, credentials);
          if (result.success) {
            await storage.set(SECRET_STORAGE_KEYS.signUp, result.browserSecret);
            return { success: true };
          }
          return result;
        } catch (cause) {
          return foldError(cause);
        }
      }),
    [convex, signUpMutation, storage, track],
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
 *   case "loading": // validating…
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
  const auth = useAuthClient();
  // Generated function references are a new object on each render, so
  // `complete` depends on the function path and reads the reference from a
  // ref.
  const mutationRef = useRef(completeSignUpMutation);
  mutationRef.current = completeSignUpMutation;
  const mutationPath = getFunctionName(completeSignUpMutation);

  const complete = useCallback(
    async (browserSecret: string) => {
      const result = await auth.signIn.mutation(mutationRef.current, {
        emailCode,
        browserSecret,
      });
      if (result.status === "complete") {
        await auth.setSession(result.tokens);
        return { done: true } as const;
      }
      return { done: false, userError: result.userError } as const;
    },
    [auth, mutationPath, emailCode],
  );

  return useLinkFlow<SignInError<ClientView<CompleteSignUpResult>>>(
    "signUp",
    complete,
    { signsIn: true },
  );
}

//------------------------------------------------------------------------------
// Password recovery
//------------------------------------------------------------------------------

/**
 * Client for starting a password recovery: run the backend's
 * `startPasswordRecovery` mutation and keep the returned secret for
 * {@link useCompletePasswordRecovery}. On success, `sentTo` gives the address
 * that received the link. Show this address to the user, not the typed one:
 * the two can differ in case or in Unicode form.
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
            return { success: true, sentTo: result.sentTo };
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
 * opens, it reads the secret stored by {@link useStartPasswordRecovery} and
 * subscribes to `checkPasswordRecovery` with it and the code from the link.
 * When the link can be used, the state is `ready`, with the function that
 * sets the new password and adopts the minted session. When the link cannot
 * be used, the state is `error`, so the page does not ask for a password.
 *
 * The check is a subscription, thus the state moves to `error` on its own
 * when the link dies while the page is open: another tab claims it, or it
 * expires and the server erases it.
 *
 * The hook does not complete the flow by itself: the flow needs the new
 * password, so call `completePasswordRecovery` when the user submits the
 * form. An error about the password keeps the state `ready`, so show it in
 * the form. An error about the link moves the state to `error`.
 *
 * ```tsx
 * function ResetPassword({ emailCode }: { emailCode: string }) {
 *   const state = useCompletePasswordRecovery(api.auth, { emailCode });
 *   const [newPassword, setNewPassword] = useState("");
 *   const [error, setError] = useState<string | null>(null);
 *
 *   switch (state.status) {
 *     case "loading":
 *       return <p>Checking the link…</p>;
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
 * @param recoveryApi The app's `checkPasswordRecovery` query and
 * `completePasswordRecovery` mutation references, for example `api.auth`.
 * @param emailCode The `code` query parameter of the link.
 */
export function useCompletePasswordRecovery(
  recoveryApi: PasswordRecoveryApi,
  { emailCode }: { emailCode: string },
): CompletePasswordRecoveryState {
  const { checkPasswordRecovery, completePasswordRecovery: completeMutation } =
    recoveryApi;
  const { isLoading } = useAuth();
  const auth = useAuthClient();
  const storage = useSecretStorage();
  const { pending, track } = usePending();
  // The secret from storage: not read yet, missing, or found.
  const [browserSecret, setBrowserSecret] = useState<undefined | null | string>(
    undefined,
  );
  // The end of the flow, once `completePasswordRecovery` reaches it. It
  // wins over the check: a completed link is a dead link for the check.
  const [outcome, setOutcome] =
    useState<
      Extract<CompletePasswordRecoveryState, { status: "complete" | "error" }>
    >();

  useEffect(() => {
    if (isLoading) {
      return;
    }
    void (async () => {
      const secret = await storage.get(SECRET_STORAGE_KEYS.passwordRecovery);
      setBrowserSecret(secret ?? null);
    })();
  }, [isLoading, storage]);

  const check = useQuery(
    checkPasswordRecovery,
    typeof browserSecret === "string" ? { emailCode, browserSecret } : "skip",
  );

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
          const result = await auth.signIn.mutation(completeMutation, {
            emailCode,
            browserSecret,
            newPassword,
          });
          if (result.status === "complete") {
            await auth.setSession(result.tokens);
            await storage.remove(SECRET_STORAGE_KEYS.passwordRecovery);
            setOutcome({ status: "complete" });
          } else if (isPasswordRecoveryLinkError(result.userError)) {
            setOutcome({ status: "error", userError: result.userError });
          }
          return result;
        } catch (cause) {
          return foldSignInError(cause);
        }
      }),
    [auth, completeMutation, emailCode, browserSecret, storage, track],
  );

  if (outcome !== undefined) {
    return outcome;
  }
  if (browserSecret === null) {
    return { status: "error", userError: { error: "MISSING_SECRET" } };
  }
  if (browserSecret === undefined || check === undefined) {
    return { status: "loading" };
  }
  // While `completePasswordRecovery` runs, the claim of the link reaches
  // the subscription before the mutation result reaches the page. Keep the
  // form until the result says what happened to the link.
  if (!check.success && !pending) {
    return { status: "error", userError: check.userError };
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

  // The user has a session, and a loading report would restart the Convex
  // client's auth handshake, so this flow does not report `isLoading`.
  return useLinkFlow<ExtractError<CompleteChangeEmailResult>>(
    "changeEmail",
    complete,
    { signsIn: false },
  );
}
