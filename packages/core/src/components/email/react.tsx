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
import { useConvex } from "convex/react";
import { useCallback, useMemo, useState } from "react";
import type { ClientView } from "../../lib/types.ts";
import { useAuthActions, useAuthSignInApi } from "../../react/index.tsx";
import { NamespacedStorage, defaultStorage } from "../../browser/storage.ts";
import type {
  SignUpResult,
  CompleteSignUpResult,
  SignInResult,
} from "./setup.ts";
/** The flows that keep a secret in the starting browser's storage. */
export type EmailPasswordFlow = "signUp";

// One storage key per flow, so concurrent flows do not overwrite each other.
const SECRET_STORAGE_KEYS: Record<EmailPasswordFlow, string> = {
  signUp: "__convexAuthEmailPasswordSignUpSecret",
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
 * The same client failure, in the shape of the shared sign-in envelope. The
 * hooks that mint a session (`completeSignUp`, `signIn`) return it, so that
 * every arm of their result has a `status`.
 */
type SignInUnexpectedFailure = {
  status: "error";
  userError: { error: "OTHER_ERROR"; cause: unknown };
};

/** {@link MissingSecretFailure} in the shape of the shared sign-in envelope. */
type SignInMissingSecretFailure = {
  status: "error";
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
  { emailCode: string; browserSecret: string; userId: string },
  ClientView<CompleteSignUpResult>
>;

type SignInMutation = FunctionReference<
  "mutation",
  "public",
  { email: string; password: string },
  ClientView<SignInResult>
>;

/** The result of the `signUp` callback from {@link useSignUpWithEmailPassword}. */
export type SignUpWithEmailPasswordResult =
  ClientView<SignUpResult> | UnexpectedFailure;

/** The result of the `completeSignUp` callback from {@link useCompleteSignUp}. */
export type CompleteSignUpClientResult =
  | ClientView<CompleteSignUpResult>
  | SignInMissingSecretFailure
  | SignInUnexpectedFailure;

/** The result of the `signIn` callback from {@link useSignInWithEmailPassword}. */
export type SignInWithEmailPasswordResult =
  ClientView<SignInResult> | SignInUnexpectedFailure;

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

const foldSignInError = (cause: unknown): SignInUnexpectedFailure => ({
  status: "error",
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
            await storage.set(SECRET_STORAGE_KEYS.signUp, result.browserSecret);
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
    async ({
      emailCode,
    }: {
      emailCode: string;
    }): Promise<CompleteSignUpClientResult> =>
      track(async () => {
        try {
          const browserSecret = await storage.get(SECRET_STORAGE_KEYS.signUp);
          const userId = await storage.get(SIGN_UP_USER_ID_STORAGE_KEY);
          if (
            browserSecret === null ||
            browserSecret === undefined ||
            userId === null ||
            userId === undefined
          ) {
            return {
              status: "error",
              userError: { error: "MISSING_SECRET" },
            };
          }
          const result = await signInApi.mutation(completeSignUpMutation, {
            emailCode,
            browserSecret,
            userId,
          });
          if (result.status === "complete") {
            await setSession(result.tokens);
            await storage.remove(SECRET_STORAGE_KEYS.signUp);
            await storage.remove(SIGN_UP_USER_ID_STORAGE_KEY);
          }
          return result;
        } catch (cause) {
          return foldSignInError(cause);
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
