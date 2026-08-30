/**
 * React client for passkey management, re-exported from
 * `@convex-dev/auth/providers/passkey/react`.
 *
 * This hooks are used on a settings page for a logged in user,
 * so that they can register a new passkey ({@link useAddPasskey})
 * and remove one ({@link useRemovePasskey}).
 *
 * There is no list hook: `listPasskeys` is a plain reactive query, so a
 * page simply reads it with `useQuery(api.auth.listPasskeys, {})`.
 *
 * @module
 */
"use client";

import { useConvex } from "convex/react";
import { useCallback, useRef } from "react";
import {
  usePasskeyCeremonySlot,
  type AlreadyPendingFailure,
} from "../react_impl.tsx";
import {
  runAddPasskeyFlow,
  runRemovePasskeyFlow,
  type AddPasskeyApi,
  type AddPasskeyFlowResult,
  type RemovePasskeyApi,
  type RemovePasskeyFlowResult,
} from "./flows.ts";

export type { AlreadyPendingFailure } from "../react_impl.tsx";
export type { AddPasskeyApi, RemovePasskeyApi } from "./flows.ts";

export type AddPasskeyResult = AddPasskeyFlowResult | AlreadyPendingFailure;

export type RemovePasskeyResult =
  RemovePasskeyFlowResult | AlreadyPendingFailure;

/**
 * Hook for the "Add a passkey" button of a settings page.
 *
 * ```tsx
 * import { useAddPasskey } from "@convex-dev/auth/providers/passkey/react";
 * import { api } from "../convex/_generated/api";
 *
 * function AddPasskeyButton() {
 *   const { addPasskey, pending } = useAddPasskey(api.auth);
 *   return (
 *     <button
 *       disabled={pending}
 *       onClick={async () => {
 *         const result = await addPasskey();
 *         if (!result.success) {
 *           // map result.userError to a message
 *         }
 *       }}
 *     >
 *       Add a passkey
 *     </button>
 *   );
 * }
 * ```
 *
 * First asks the user to authenticate with an existing passkey to prove
 * their identity, then registers a new passkey.
 *
 * @param managementApi The app module that re-exports the
 *   passkey-management functions of the provider, for example `api.auth`.
 */
// TODO(nicolas) Change the return value to allow showing a different UI before creating the new passkey
export function useAddPasskey(managementApi: AddPasskeyApi) {
  const convex = useConvex();

  const { run, pending } = usePasskeyCeremonySlot({
    // Not a log in page, so there is no autofill here
    autofill: null,
  });

  // Store these in a ref because we only need them in an event handler
  // (this allows the callback to stay stable).
  const ctxRef = useRef({ convex, api: managementApi });
  ctxRef.current = { convex, api: managementApi };

  const addPasskey = useCallback(
    (): Promise<AddPasskeyResult> =>
      run(() => runAddPasskeyFlow(ctxRef.current)),
    [run],
  );

  return {
    /**
     * Adds a passkey to the account of the signed-in user.
     *
     * Returns an object with a `success` boolean flag. If it is `false`,
     * the object has a `userError` field that tells why.
     */
    addPasskey,
    /** `true` while an `addPasskey` call is running. */
    pending,
  };
}

/**
 * Hook for the "Remove" button of a passkey list.
 *
 * ```tsx
 * import { useRemovePasskey } from "@convex-dev/auth/providers/passkey/react";
 * import { api } from "../convex/_generated/api";
 *
 * function RemovePasskeyButton({ passkeyId }: { passkeyId: string }) {
 *   const { removePasskey, pending } = useRemovePasskey(api.auth);
 *   return (
 *     <button
 *       disabled={pending}
 *       onClick={async () => {
 *         const result = await removePasskey(passkeyId);
 *         if (!result.success) {
 *           // map result.userError to a message
 *         }
 *       }}
 *     >
 *       Remove
 *     </button>
 *   );
 * }
 * ```
 *
 * This asks the user to reauthenticate with another passkey
 * before deleting the targeted passkey.
 *
 * @param managementApi The app module that re-exports the
 *   passkey-management functions of the provider, for example `api.auth`.
 */
export function useRemovePasskey(managementApi: RemovePasskeyApi) {
  const convex = useConvex();
  const { run, pending } = usePasskeyCeremonySlot({ autofill: null });

  // Store these in a ref because we only need them in an event handler
  // (this allows the callback to stay stable).
  const ctxRef = useRef({ convex, api: managementApi });
  ctxRef.current = { convex, api: managementApi };

  const removePasskey = useCallback(
    (passkeyId: string): Promise<RemovePasskeyResult> =>
      run(() => runRemovePasskeyFlow(ctxRef.current, { passkeyId })),
    [run],
  );

  return {
    /**
     * Removes the given passkey from the account of the signed-in user.
     *
     * Returns an object with a `success` boolean flag. If it is `false`,
     * the object has a `userError` field that tells why.
     */
    removePasskey,
    /** `true` while a `removePasskey` call is running. */
    pending,
  };
}
