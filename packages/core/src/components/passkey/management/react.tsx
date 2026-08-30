/**
 * React client for passkey management, re-exported from
 * `@convex-dev/auth/providers/passkey/react`.
 *
 * The hooks drive the settings page of a signed-in user: {@link useAddPasskey}
 * adds a passkey, {@link useRemovePasskey} removes one. They are separate
 * from the sign-in hooks in `react.tsx`, because a settings page and a
 * login form share no state.
 *
 * There is no list hook: `listPasskeys` is a plain reactive query, so a
 * page reads it with `useQuery(api.auth.listPasskeys, {})` and the list
 * updates live after every add and remove.
 *
 * The browser runs one WebAuthn ceremony at a time per page. A call on the
 * same hook instance while its flow still runs comes back as
 * `ALREADY_PENDING` without disturbing that flow; a ceremony from a
 * different hook instance displaces the pending dialog, and the displaced
 * flow returns `CEREMONY_ABORTED`.
 *
 * The flows themselves live in `flows.ts`, which has no React. These hooks
 * hold the function references and run one flow at a time.
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

/**
 * The result of the `addPasskey` callback from {@link useAddPasskey}: the
 * passkey ID on success, or a `userError` from any step of the flow.
 */
export type AddPasskeyResult = AddPasskeyFlowResult | AlreadyPendingFailure;

/**
 * The result of the `removePasskey` callback from {@link useRemovePasskey}:
 * the removal happened, or a `userError` from any step of the flow.
 */
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
 * `addPasskey` opens two browser dialogs one after the other: the user
 * first proves the account with a passkey they already hold, then makes
 * the new passkey.
 *
 * @param managementApi The app module that re-exports the
 *   passkey-management functions of the provider, for example `api.auth`.
 */
// TODO(nicolas) Change the return value to allow showing a different UI before creating the new passkey
export function useAddPasskey(managementApi: AddPasskeyApi) {
  const convex = useConvex();
  // A settings page runs no autofill flow, thus the slot pauses nothing.
  const { run, pending } = usePasskeyCeremonySlot({ autofill: null });

  // The callback reads the function references and the client through a
  // ref: their identities are not stable across renders (Convex's
  // generated `api` object creates a new reference on every property
  // access), and the identity of `addPasskey` must not change on a render.
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
 * Hook for the "Remove" button of a passkey list. Give each row its own
 * instance when it wants its own spinner: `pending` tracks only the calls
 * of that instance.
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
 * `removePasskey` opens one browser dialog: the user must authorize the
 * removal with a DIFFERENT passkey of the account. The server refuses to
 * remove the last passkey (`LAST_PASSKEY`), thus a user never locks
 * themselves out.
 *
 * @param managementApi The app module that re-exports the
 *   passkey-management functions of the provider, for example `api.auth`.
 */
export function useRemovePasskey(managementApi: RemovePasskeyApi) {
  const convex = useConvex();
  const { run, pending } = usePasskeyCeremonySlot({ autofill: null });

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
