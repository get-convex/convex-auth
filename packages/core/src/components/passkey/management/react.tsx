/**
 * React client for passkey management, re-exported from
 * `@convex-dev/auth/providers/passkey/react`.
 *
 * The `usePasskeyManagement` hook drives the settings page of a signed-in
 * user: it lists the passkeys of the user, adds one, and removes one. The
 * sign-in hook (`usePasskey`) is a different hook, because a settings page
 * and a login form share no state.
 *
 * @module
 */
"use client";

import { useConvex, useQuery, type ConvexReactClient } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useCallback, useRef, useState } from "react";
import {
  type AssertionArgs,
  type ClientFailure,
  foldClientError,
  type RegistrationCeremonyArgs,
  runAuthenticationCeremony,
  runRegistrationCeremony,
  supportsWebAuthn,
} from "../ceremonies.ts";
import type {
  FinishAddPasskeyResult,
  StartAddPasskeyResult,
  VerifyAddPasskeyResult,
} from "./add.ts";
import type { ListPasskeysResult } from "./list.ts";
import type {
  FinishRemovePasskeyResult,
  StartRemovePasskeyResult,
} from "./remove.ts";

/** The `listPasskeys` query the app re-exports from the provider. */
type ListPasskeysQuery = FunctionReference<
  "query",
  "public",
  Record<string, never>,
  ListPasskeysResult
>;

/** The `startAddPasskey` mutation of the provider. */
type StartAddPasskeyMutation = FunctionReference<
  "mutation",
  "public",
  Record<string, never>,
  StartAddPasskeyResult
>;

/** The `verifyAddPasskey` mutation of the provider. */
type VerifyAddPasskeyMutation = FunctionReference<
  "mutation",
  "public",
  AssertionArgs,
  VerifyAddPasskeyResult
>;

/** The `finishAddPasskey` mutation of the provider. */
type FinishAddPasskeyMutation = FunctionReference<
  "mutation",
  "public",
  RegistrationCeremonyArgs,
  FinishAddPasskeyResult
>;

/** The `startRemovePasskey` mutation of the provider. */
type StartRemovePasskeyMutation = FunctionReference<
  "mutation",
  "public",
  { passkeyId: string },
  StartRemovePasskeyResult
>;

/** The `finishRemovePasskey` mutation of the provider. */
type FinishRemovePasskeyMutation = FunctionReference<
  "mutation",
  "public",
  AssertionArgs & { passkeyId: string },
  FinishRemovePasskeyResult
>;

/**
 * The function references {@link usePasskeyManagement} drives.
 * `setupUsernamePasskey` returns them next to the sign-in functions, thus
 * the app module that re-exports the provider carries them all.
 */
export type PasskeyManagementApi = {
  listPasskeys: ListPasskeysQuery;
  startAddPasskey: StartAddPasskeyMutation;
  verifyAddPasskey: VerifyAddPasskeyMutation;
  finishAddPasskey: FinishAddPasskeyMutation;
  startRemovePasskey: StartRemovePasskeyMutation;
  finishRemovePasskey: FinishRemovePasskeyMutation;
};

/** The display data of one passkey of the user. */
export type PasskeyMetadata = Extract<
  ListPasskeysResult,
  { success: true }
>["passkeys"][number];

/**
 * The result of the `addPasskey` callback from
 * {@link usePasskeyManagement}: the passkey ID on success, or a `userError`
 * from any step of the flow ({@link ClientFailure} included).
 */
export type AddPasskeyResult =
  | FinishAddPasskeyResult
  | Extract<StartAddPasskeyResult, { success: false }>
  | Extract<VerifyAddPasskeyResult, { success: false }>
  | ClientFailure;

/**
 * The result of the `removePasskey` callback from
 * {@link usePasskeyManagement}: the removal happened, or a `userError` from
 * any step of the flow ({@link ClientFailure} included).
 */
export type RemovePasskeyResult =
  | FinishRemovePasskeyResult
  | Extract<StartRemovePasskeyResult, { success: false }>
  | ClientFailure;

// The WebAuthn `user.name` and `user.displayName` of the new passkey when
// the account has no username. The passkey manager of the browser shows
// this text, thus it must not be empty.
const NAMELESS_USER_DISPLAY_NAME = "user";

/**
 * Client for the passkey settings page of a signed-in user.
 *
 * ```tsx
 * import { usePasskeyManagement } from "@convex-dev/auth/providers/passkey/react";
 * import { api } from "../convex/_generated/api";
 *
 * function PasskeySettings() {
 *   const { passkeys, addPasskey, removePasskey, pending } =
 *     usePasskeyManagement(api.auth);
 *   if (passkeys === undefined) {
 *     return <p>Loading…</p>;
 *   }
 *   return (
 *     <ul>
 *       {passkeys.map((passkey) => (
 *         <li key={passkey.passkeyId}>
 *           {passkey.name}
 *           <button
 *             disabled={pending}
 *             onClick={() => removePasskey(passkey.passkeyId)}
 *           >
 *             Remove
 *           </button>
 *         </li>
 *       ))}
 *       <button disabled={pending} onClick={() => addPasskey()}>
 *         Add a passkey
 *       </button>
 *     </ul>
 *   );
 * }
 * ```
 *
 * Both `addPasskey` and `removePasskey` ask the user to prove again that
 * they hold a passkey of the account. `addPasskey` thus opens two browser
 * dialogs one after the other: the first proves the account, the second
 * makes the new passkey.
 *
 * @param managementApi The app module that re-exports the
 *   passkey-management functions of the provider, for example `api.auth`.
 */
export function usePasskeyManagement(managementApi: PasskeyManagementApi) {
  // Every function of the group acts on the caller of the session and mints
  // no session of its own, thus they all go straight to the deployment.
  // (The sign-in hook sends its finishing mutations through the auth proxy
  // instead; see the comment in `react.tsx`.)
  const convex = useConvex();

  const [pending, setPending] = useState(false);
  // The re-entry guard reads through a ref: `pending` from `useState` would
  // be stale inside the callbacks.
  const pendingRef = useRef(false);

  // The callbacks read the function references and the client through a
  // ref: their identities are not stable across renders (Convex's generated
  // `api` object creates a new reference on every property access), and the
  // identity of `addPasskey` and `removePasskey` must not change on a
  // render.
  const currentRef = useRef({ managementApi, convex });
  currentRef.current = { managementApi, convex };

  const listed = useQuery(managementApi.listPasskeys, {});

  /**
   * Run one management flow. The two flows cannot overlap: a browser
   * refuses a second modal ceremony while one runs, and each flow needs
   * the full attention of the user.
   */
  const runExclusive = useCallback(
    async <Result,>(
      flow: (
        convex: ConvexReactClient,
        managementApi: PasskeyManagementApi,
      ) => Promise<Result>,
    ): Promise<Result | ClientFailure> => {
      if (pendingRef.current) {
        return { success: false, userError: { error: "CEREMONY_ABORTED" } };
      }
      pendingRef.current = true;
      setPending(true);
      try {
        if (!supportsWebAuthn()) {
          return {
            success: false,
            userError: { error: "WEBAUTHN_UNSUPPORTED" },
          };
        }
        const current = currentRef.current;
        return await flow(current.convex, current.managementApi);
      } catch (cause) {
        return { success: false, userError: foldClientError(cause) };
      } finally {
        // Reset even when something throws.
        pendingRef.current = false;
        setPending(false);
      }
    },
    [],
  );

  const addPasskey = useCallback(
    (): Promise<AddPasskeyResult> =>
      runExclusive(async (convex, api): Promise<AddPasskeyResult> => {
        const start = await convex.mutation(api.startAddPasskey, {});
        if (!start.success) {
          return start;
        }
        const assertion = await runAuthenticationCeremony(start);
        if (assertion === null) {
          return { success: false, userError: { error: "CEREMONY_ABORTED" } };
        }
        // The registration challenge that this step mints is the proof of
        // the assertion above, thus the new passkey needs no other token.
        const verified = await convex.mutation(api.verifyAddPasskey, assertion);
        if (!verified.success) {
          return verified;
        }
        const registration = await runRegistrationCeremony(
          verified.username ?? NAMELESS_USER_DISPLAY_NAME,
          verified,
        );
        if (registration === null) {
          return { success: false, userError: { error: "CEREMONY_ABORTED" } };
        }
        return await convex.mutation(api.finishAddPasskey, registration);
      }),
    [runExclusive],
  );

  const removePasskey = useCallback(
    (passkeyId: string): Promise<RemovePasskeyResult> =>
      runExclusive(async (convex, api): Promise<RemovePasskeyResult> => {
        const start = await convex.mutation(api.startRemovePasskey, {
          passkeyId,
        });
        if (!start.success) {
          return start;
        }
        const assertion = await runAuthenticationCeremony(start);
        if (assertion === null) {
          return { success: false, userError: { error: "CEREMONY_ABORTED" } };
        }
        return await convex.mutation(api.finishRemovePasskey, {
          passkeyId,
          ...assertion,
        });
      }),
    [runExclusive],
  );

  return {
    /**
     * The passkeys of the user, newest first as the server gives them.
     *
     * `undefined` while the subscription loads, and also when `listError`
     * says that the query refused to answer.
     */
    passkeys: listed?.success === true ? listed.passkeys : undefined,
    /**
     * Why the list stays `undefined`, or `null` when nothing went wrong.
     * The one error today is `NOT_SIGNED_IN`: the session ended while the
     * page was open. Show the login form again.
     */
    listError:
      listed !== undefined && !listed.success ? listed.userError : null,
    /**
     * Adds a passkey to the account of the signed-in user.
     *
     * The call opens two browser dialogs: the user first proves the
     * account with a passkey they already hold, then makes the new
     * passkey.
     *
     * Returns an object with a `success` boolean flag. If it is `false`,
     * the object has a `userError` field that tells why.
     */
    addPasskey,
    /**
     * Removes the given passkey from the account of the signed-in user.
     *
     * The call opens one browser dialog: the user must authorize the
     * removal with a DIFFERENT passkey of the account. The server refuses
     * to remove the last passkey (`LAST_PASSKEY`), thus a user never locks
     * themselves out.
     *
     * Returns an object with a `success` boolean flag. If it is `false`,
     * the object has a `userError` field that tells why.
     */
    removePasskey,
    /** `true` while an `addPasskey` or `removePasskey` call is running. */
    pending,
  };
}
