import { GenericActionCtx, GenericDataModel } from "convex/server";
import {
  CompleteSignInFunc,
  TokenBundle,
  USE_USER_ID_AS_ACCOUNT_ID,
} from "../../lib/types";
import type { ComponentApi as UsernameComponentApi } from "./_generated/component.js";

/**
 * The subset of a Convex `ctx` that {@link signUpWithUsername} needs. A
 * mutation `ctx` satisfies it.
 */
type RunQueryAndMutationCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;

/**
 * The result of {@link signUpWithUsername}: the minted session tokens, or
 * `USERNAME_TAKEN` when a different user already has the username.
 */
export type SignUpWithUsernameResult =
  | { success: true; tokens: TokenBundle }
  | { success: false; userError: { error: "USERNAME_TAKEN" } };

/**
 * Claim a username for a new account: check that the username is free,
 * create the account + app user (via the app's `createOrUpdateUser`), mint
 * the session, and store the username. The shared sign-up step of the
 * username-based providers (password, passkey).
 *
 * Call it from a mutation, after the provider validated the username format
 * (`validateUsernameFormat`) and its own credential input. Inside one
 * mutation, the free-username check and the `setUsername` claim below cannot
 * race, so a `USERNAME_TAKEN` failure can only occur here, before anything
 * is created; after a success, the caller can do more writes in the same
 * transaction and throw to roll everything (the user, the account, the
 * session, and the username) back.
 */
export async function signUpWithUsername(
  ctx: RunQueryAndMutationCtx,
  args: {
    usernameComponent: UsernameComponentApi;
    completeSignIn: CompleteSignInFunc;
    /** The provider name for the claims, for example "password". */
    provider: string;
    /** The username to claim. Must have a valid format (see above). */
    username: string;
    /** The profile for the app's `createOrUpdateUser` callback. */
    profile: Record<string, unknown>;
  },
): Promise<SignUpWithUsernameResult> {
  const { usernameComponent, completeSignIn, provider, username, profile } =
    args;

  const existing = await ctx.runQuery(
    usernameComponent.public.getUserIdByUsername,
    { username },
  );
  if (existing !== null) {
    return { success: false, userError: { error: "USERNAME_TAKEN" } };
  }

  // Create the account + app user and mint the session. These accounts are
  // keyed by the app user id, which does not exist before this call mints
  // it, hence the placeholder; sign-in passes the user id itself.
  //
  // TODO(nicolas) The app's `createOrUpdateUser` callback should not
  // receive a provider account ID for these providers at all: the value is
  // an internal key ("" at sign-up, the user id afterwards) with no meaning
  // to the app. We will probably improve this when providers support
  // typesafe profiles.
  const tokens = await completeSignIn(ctx, {
    provider,
    providerAccountId: USE_USER_ID_AS_ACCOUNT_ID,
    profile,
  });

  const setUsernameResult = await ctx.runMutation(
    usernameComponent.public.setUsername,
    { userId: tokens.userId, username },
  );
  if (!setUsernameResult.success) {
    // Not possible: the caller validated the username format, and the
    // username was free above, in the same transaction. Throwing rolls the
    // user, the account, and the session back.
    throw new Error(
      "Unexpected error when setting the username: " +
        setUsernameResult.userError.error,
      { cause: setUsernameResult.userError },
    );
  }

  return { success: true, tokens };
}
