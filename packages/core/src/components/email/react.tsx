/**
 * React client for the `EmailPassword` provider, exported at
 * `@convex-dev/auth/providers/email-password/react`.
 *
 * A provider's job on the client is to run its own flows and hand any
 * resulting token bundle to the core client's `setSession` (see
 * `useAuthActions`).
 *
 * The email flows split in two: a *start* call sends a challenge link and
 * returns a secret, and a *complete* call presents the code from the link
 * together with that secret. The hooks keep the secret in the browser's
 * local storage (namespaced by deployment URL), so a link only works in the
 * browser that started the flow. When a link is opened elsewhere, the
 * complete hooks return a client-only `MISSING_SECRET` error.
 *
 * Each hook returns a function for running its flow step and a `pending`
 * flag that is `true` while the step is in flight.
 *
 * @module
 */
"use client";

import { FunctionReference } from "convex/server";
import { useConvex, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClientView } from "../../lib/types.ts";
import { useAuthActions, useAuthSignInApi } from "../../react/index.tsx";
import { NamespacedStorage, defaultStorage } from "../../browser/storage.ts";
import type {
  SignUpResult,
  CompleteSignUpResult,
  SignInResult,
  ChangePasswordResult,
  StartChangeEmailResult,
  CompleteChangeEmailResult,
  StartRecoveryResult,
  CompleteRecoveryResult,
} from "./setup.ts";
import type { ChallengeStatus, EmailPasswordFlow } from "./validation.ts";

/** The flows that keep a secret in the starting browser's storage. */
export type { EmailPasswordFlow };

// One storage key per flow, so concurrent flows do not overwrite each other.
const SECRET_STORAGE_KEYS: Record<EmailPasswordFlow, string> = {
  signUp: "__convexAuthEmailPasswordSignUpSecret",
  changeEmail: "__convexAuthEmailPasswordChangeEmailSecret",
  recovery: "__convexAuthEmailPasswordRecoverySecret",
};

// The sign-up link is bound to the new user, and nobody is signed in until
// the link is opened, so the browser keeps the `userId` next to the secret.
const SIGN_UP_USER_ID_STORAGE_KEY = "__convexAuthEmailPasswordSignUpUserId";

/**
 * A failure the client produces that the server never returns: the mutation
 * threw (a network blip, a bug, an unexpected server error) rather than
 * resolving to a `userError`. The hooks fold that into the result as
 * `OTHER_ERROR` so callers handle *every* failure through the one
 * `userError` switch. The thrown value is preserved on `cause`.
 */
type UnexpectedFailure = {
  success: false;
  userError: { error: "OTHER_ERROR"; cause: unknown };
};

/**
 * A failure the client produces when a challenge link is opened in a
 * browser that did not start the flow: the flow's secret is not in this
 * browser's storage, so completion cannot proceed. Tell the user to open the
 * link in the browser they started from.
 */
type MissingSecretFailure = {
  success: false;
  userError: { error: "MISSING_SECRET" };
};

type SignUpMutation = FunctionReference<
  "mutation",
  "public",
  { email: string; password: string },
  ClientView<SignUpResult>
>;

type CompleteSignUpMutation = FunctionReference<
  "mutation",
  "public",
  { code: string; secret: string; userId: string },
  ClientView<CompleteSignUpResult>
>;

type SignInMutation = FunctionReference<
  "mutation",
  "public",
  { email: string; password: string },
  ClientView<SignInResult>
>;

type ChangePasswordMutation = FunctionReference<
  "mutation",
  "public",
  { currentPassword: string; newPassword: string },
  ChangePasswordResult
>;

type StartChangeEmailMutation = FunctionReference<
  "mutation",
  "public",
  { newEmail: string; currentPassword: string },
  StartChangeEmailResult
>;

type CompleteChangeEmailMutation = FunctionReference<
  "mutation",
  "public",
  { code: string; secret: string },
  CompleteChangeEmailResult
>;

type StartRecoveryMutation = FunctionReference<
  "mutation",
  "public",
  { email: string },
  StartRecoveryResult
>;

type CompleteRecoveryMutation = FunctionReference<
  "mutation",
  "public",
  { code: string; secret: string; newPassword: string },
  ClientView<CompleteRecoveryResult>
>;

type GetChallengeStatusQuery = FunctionReference<
  "query",
  "public",
  { code: string; secret: string; flow: EmailPasswordFlow; userId?: string },
  ChallengeStatus
>;

/** The result of the `signUp` callback from {@link useSignUpWithEmailPassword}. */
export type SignUpWithEmailPasswordResult =
  ClientView<SignUpResult> | UnexpectedFailure;

/** The result of the `completeSignUp` callback from {@link useCompleteSignUp}. */
export type CompleteSignUpClientResult =
  ClientView<CompleteSignUpResult> | MissingSecretFailure | UnexpectedFailure;

/** The result of the `signIn` callback from {@link useSignInWithEmailPassword}. */
export type SignInWithEmailPasswordResult =
  ClientView<SignInResult> | UnexpectedFailure;

/** The result of the `changePassword` callback from {@link useChangePassword}. */
export type ChangePasswordClientResult =
  ChangePasswordResult | UnexpectedFailure;

/** The result of the `startChangeEmail` callback from {@link useStartChangeEmail}. */
export type StartChangeEmailClientResult =
  StartChangeEmailResult | UnexpectedFailure;

/** The result of the `completeChangeEmail` callback from {@link useCompleteChangeEmail}. */
export type CompleteChangeEmailClientResult =
  CompleteChangeEmailResult | MissingSecretFailure | UnexpectedFailure;

/** The result of the `startRecovery` callback from {@link useStartRecovery}. */
export type StartRecoveryClientResult = StartRecoveryResult | UnexpectedFailure;

/** The result of the `completeRecovery` callback from {@link useCompleteRecovery}. */
export type CompleteRecoveryClientResult =
  ClientView<CompleteRecoveryResult> | MissingSecretFailure | UnexpectedFailure;

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

/** Track an async call's in-flight state. */
function usePending() {
  const [pending, setPending] = useState(false);
  const track = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    setPending(true);
    try {
      return await work();
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, track };
}

const foldError = (cause: unknown): UnexpectedFailure => ({
  success: false,
  userError: { error: "OTHER_ERROR", cause },
});

/**
 * Client for the sign-up flow: run the backend's `signUp` mutation and keep
 * the returned secret for {@link useCompleteSignUp}.
 *
 * A successful sign-up does *not* sign the user in: it sends the validation
 * email. Tell the user to open the link (in this same browser).
 *
 * ```tsx
 * const { signUp, pending } = useSignUpWithEmailPassword(api.auth.signUp);
 * const result = await signUp({ email, password });
 * if (!result.success) {
 *   // map result.userError to a message
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
            await storage.set(SECRET_STORAGE_KEYS.signUp, result.secret);
            await storage.set(SIGN_UP_USER_ID_STORAGE_KEY, result.userId);
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
 * Client for completing a sign-up from the validation landing page: read the
 * secret stored by {@link useSignUpWithEmailPassword}, run the backend's
 * `completeSignUp` mutation with the code from the link, and adopt the
 * minted session.
 *
 * Returns `MISSING_SECRET` when this browser did not start the flow.
 *
 * @param completeSignUpMutation The app's `completeSignUp` mutation reference.
 */
export function useCompleteSignUp(
  completeSignUpMutation: CompleteSignUpMutation,
) {
  const { setSession } = useAuthActions();
  const signInApi = useAuthSignInApi();
  const storage = useSecretStorage();
  const { pending, track } = usePending();

  const completeSignUp = useCallback(
    async ({ code }: { code: string }): Promise<CompleteSignUpClientResult> =>
      track(async () => {
        try {
          const secret = await storage.get(SECRET_STORAGE_KEYS.signUp);
          const userId = await storage.get(SIGN_UP_USER_ID_STORAGE_KEY);
          if (
            secret === null ||
            secret === undefined ||
            userId === null ||
            userId === undefined
          ) {
            return {
              success: false,
              userError: { error: "MISSING_SECRET" },
            };
          }
          const result = await signInApi.mutation(completeSignUpMutation, {
            code,
            secret,
            userId,
          });
          if (result.success) {
            await setSession(result.tokens);
            await storage.remove(SECRET_STORAGE_KEYS.signUp);
            await storage.remove(SIGN_UP_USER_ID_STORAGE_KEY);
          }
          return result;
        } catch (cause) {
          return foldError(cause);
        }
      }),
    [signInApi, completeSignUpMutation, storage, setSession, track],
  );

  return { completeSignUp, pending };
}

/**
 * Client for the sign-in flow: run the backend's `signIn` mutation and, on
 * success, establish an authenticated session.
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
          if (result.success) {
            await setSession(result.tokens);
          }
          return result;
        } catch (cause) {
          return foldError(cause);
        }
      }),
    [signInApi, signInMutation, setSession, track],
  );

  return { signIn, pending };
}

/**
 * Client for changing the signed-in user's password. Requires the current
 * password; the session is unchanged.
 *
 * @param changePasswordMutation The app's `changePassword` mutation reference.
 */
export function useChangePassword(
  changePasswordMutation: ChangePasswordMutation,
) {
  const signInApi = useAuthSignInApi();
  const { pending, track } = usePending();

  const changePassword = useCallback(
    async (args: {
      currentPassword: string;
      newPassword: string;
    }): Promise<ChangePasswordClientResult> =>
      track(async () => {
        try {
          return await signInApi.mutation(changePasswordMutation, args);
        } catch (cause) {
          return foldError(cause);
        }
      }),
    [signInApi, changePasswordMutation, track],
  );

  return { changePassword, pending };
}

/**
 * Client for starting an email change: run the backend's `startChangeEmail`
 * mutation and keep the returned secret for {@link useCompleteChangeEmail}.
 *
 * @param startChangeEmailMutation The app's `startChangeEmail` mutation reference.
 */
export function useStartChangeEmail(
  startChangeEmailMutation: StartChangeEmailMutation,
) {
  const signInApi = useAuthSignInApi();
  const storage = useSecretStorage();
  const { pending, track } = usePending();

  const startChangeEmail = useCallback(
    async (args: {
      newEmail: string;
      currentPassword: string;
    }): Promise<StartChangeEmailClientResult> =>
      track(async () => {
        try {
          const result = await signInApi.mutation(
            startChangeEmailMutation,
            args,
          );
          if (result.success) {
            await storage.set(SECRET_STORAGE_KEYS.changeEmail, result.secret);
          }
          return result;
        } catch (cause) {
          return foldError(cause);
        }
      }),
    [signInApi, startChangeEmailMutation, storage, track],
  );

  return { startChangeEmail, pending };
}

/**
 * Client for completing an email change from the confirmation landing page.
 * No session is adopted — the user already has one.
 *
 * Returns `MISSING_SECRET` when this browser did not start the flow.
 *
 * @param completeChangeEmailMutation The app's `completeChangeEmail` mutation reference.
 */
export function useCompleteChangeEmail(
  completeChangeEmailMutation: CompleteChangeEmailMutation,
) {
  const signInApi = useAuthSignInApi();
  const storage = useSecretStorage();
  const { pending, track } = usePending();

  const completeChangeEmail = useCallback(
    async ({
      code,
    }: {
      code: string;
    }): Promise<CompleteChangeEmailClientResult> =>
      track(async () => {
        try {
          const secret = await storage.get(SECRET_STORAGE_KEYS.changeEmail);
          if (secret === null || secret === undefined) {
            return {
              success: false,
              userError: { error: "MISSING_SECRET" },
            };
          }
          const result = await signInApi.mutation(completeChangeEmailMutation, {
            code,
            secret,
          });
          if (result.success) {
            await storage.remove(SECRET_STORAGE_KEYS.changeEmail);
          }
          return result;
        } catch (cause) {
          return foldError(cause);
        }
      }),
    [signInApi, completeChangeEmailMutation, storage, track],
  );

  return { completeChangeEmail, pending };
}

/**
 * Client for starting a password recovery: run the backend's `startRecovery`
 * mutation and keep the returned secret for {@link useCompleteRecovery}.
 *
 * @param startRecoveryMutation The app's `startRecovery` mutation reference.
 */
export function useStartRecovery(startRecoveryMutation: StartRecoveryMutation) {
  const signInApi = useAuthSignInApi();
  const storage = useSecretStorage();
  const { pending, track } = usePending();

  const startRecovery = useCallback(
    async (args: { email: string }): Promise<StartRecoveryClientResult> =>
      track(async () => {
        try {
          const result = await signInApi.mutation(startRecoveryMutation, args);
          if (result.success) {
            await storage.set(SECRET_STORAGE_KEYS.recovery, result.secret);
          }
          return result;
        } catch (cause) {
          return foldError(cause);
        }
      }),
    [signInApi, startRecoveryMutation, storage, track],
  );

  return { startRecovery, pending };
}

/**
 * Client for completing a password recovery from the reset landing page:
 * read the stored secret, set the new password, and adopt the minted
 * session.
 *
 * Returns `MISSING_SECRET` when this browser did not start the flow.
 *
 * @param completeRecoveryMutation The app's `completeRecovery` mutation reference.
 */
export function useCompleteRecovery(
  completeRecoveryMutation: CompleteRecoveryMutation,
) {
  const { setSession } = useAuthActions();
  const signInApi = useAuthSignInApi();
  const storage = useSecretStorage();
  const { pending, track } = usePending();

  const completeRecovery = useCallback(
    async (args: {
      code: string;
      newPassword: string;
    }): Promise<CompleteRecoveryClientResult> =>
      track(async () => {
        try {
          const secret = await storage.get(SECRET_STORAGE_KEYS.recovery);
          if (secret === null || secret === undefined) {
            return {
              success: false,
              userError: { error: "MISSING_SECRET" },
            };
          }
          const result = await signInApi.mutation(completeRecoveryMutation, {
            code: args.code,
            secret,
            newPassword: args.newPassword,
          });
          if (result.success) {
            await setSession(result.tokens);
            await storage.remove(SECRET_STORAGE_KEYS.recovery);
          }
          return result;
        } catch (cause) {
          return foldError(cause);
        }
      }),
    [signInApi, completeRecoveryMutation, storage, setSession, track],
  );

  return { completeRecovery, pending };
}

/**
 * What a landing page shows for a challenge link:
 *
 * - `undefined` while the secret and the status load,
 * - `{ status: "missingSecret" }` when this browser did not start the flow,
 * - `{ status: "pending", email }` for a usable link,
 * - `{ status: "invalid" }` for an unknown, expired or claimed link.
 */
export type UseChallengeStatusResult =
  ChallengeStatus | { status: "missingSecret" } | undefined;

/**
 * Subscribe to the state of a challenge link, for landing pages: read the
 * flow's secret from storage, then run the backend's `getChallengeStatus`
 * query with it.
 *
 * @param statusQuery The app's `getChallengeStatus` query reference.
 * @param args The `code` from the link's query parameter, and which `flow`
 *   the landing page serves (`"signUp"`, `"changeEmail"` or `"recovery"`).
 */
export function useChallengeStatus(
  statusQuery: GetChallengeStatusQuery,
  { code, flow }: { code: string; flow: EmailPasswordFlow },
): UseChallengeStatusResult {
  const storage = useSecretStorage();
  // What the starting browser kept: the secret, and for sign-up the user.
  // `undefined` = still reading storage; `null` = this browser did not start
  // the flow.
  const [kept, setKept] = useState<
    { secret: string; userId?: string } | null | undefined
  >(undefined);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      const secret = await storage.get(SECRET_STORAGE_KEYS[flow]);
      const userId =
        flow === "signUp"
          ? await storage.get(SIGN_UP_USER_ID_STORAGE_KEY)
          : undefined;
      if (canceled) {
        return;
      }
      if (
        secret === null ||
        secret === undefined ||
        (flow === "signUp" && (userId === null || userId === undefined))
      ) {
        setKept(null);
      } else {
        setKept({ secret, userId: userId ?? undefined });
      }
    })();
    return () => {
      canceled = true;
    };
  }, [storage, flow]);

  const status = useQuery(
    statusQuery,
    kept === null || kept === undefined ? "skip" : { code, flow, ...kept },
  );

  if (kept === undefined) {
    return undefined;
  }
  if (kept === null) {
    return { status: "missingSecret" };
  }
  return status;
}
