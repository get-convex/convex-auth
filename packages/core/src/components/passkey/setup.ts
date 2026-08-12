import { mutationGeneric, queryGeneric, type Auth } from "convex/server";
import { Infer, v } from "convex/values";
import { defineProvider, vTokenBundle } from "../../lib/types";
import type { ComponentApi } from "./_generated/component.js";
import type { ComponentApi as UsernameComponentApi } from "../username/_generated/component.js";
import {
  setUsernameUserError,
  validateUsernameFormat,
} from "../username/validation";
import {
  finishAuthenticationUserError,
  finishRegistrationUserError,
} from "./validation";

/**
 * Options for {@link UsernamePasskey}.
 */
export type UsernamePasskeyOptions = {
  /**
   * The mounted passkey component (`components.authPasskey`). The provider
   * drives its registration and authentication ceremonies.
   */
  component: ComponentApi;
  /**
   * The mounted username component (`components.authUsername`). The provider
   * uses it to map a username onto the app user id: it stores the username
   * at sign-up and reads it back at sign-in.
   */
  usernameComponent: UsernameComponentApi;
  /**
   * The WebAuthn relying party ID. This is usually the registrable domain
   * that serves the app (for example, "example.com" or "localhost"). Only
   * web pages on this domain, or on its subdomains, can use the passkeys.
   * See https://web.dev/articles/webauthn-rp-id
   */
  rpId: string;
  /**
   * The expected web origin of each ceremony (for example,
   * "https://app.example.com" or "http://localhost:5173").
   */
  origin: string;
};

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "passkey";

/**
 * Read the signed-in user's id from the verified access token. Convex
 * checks the token signature before the function runs, so the subject is a
 * trustworthy value. Throws when no user is signed in: a correct client
 * only calls the management functions with a session.
 */
async function requireUserId(ctx: { auth: Auth }): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new Error("This function requires a signed-in user.");
  }
  return identity.subject;
}

const startSignInResult = v.union(
  // The username exists. The client must complete an authentication
  // ceremony (`navigator.credentials.get`) and call `finishSignIn`.
  v.object({
    step: v.literal("authenticate"),
    challenge: v.bytes(),
    allowCredentials: v.array(v.bytes()),
  }),
  // The username is free. A new empty user row now exists, and the client
  // must complete a registration ceremony (`navigator.credentials.create`)
  // and call `finishSignUp`. `userHandle` is the new user's id; the client
  // encodes it to bytes for the WebAuthn `user.id` field.
  v.object({
    step: v.literal("register"),
    challenge: v.bytes(),
    userHandle: v.string(),
    excludeCredentials: v.array(v.bytes()),
  }),
);

/**
 * The result of `startSignIn`: the branch of the flow and the data for the
 * matching WebAuthn ceremony.
 */
export type StartSignInResult = Infer<typeof startSignInResult>;

const finishSignUpResult = v.union(
  v.object({
    success: v.literal(true),
    tokens: vTokenBundle,
    username: v.string(),
  }),
  v.object({
    success: v.literal(false),
    // `setUsernameUserError` covers `USERNAME_TAKEN` and the format errors
    // of the username component.
    userError: v.union(finishRegistrationUserError, setUsernameUserError),
  }),
);

/**
 * The result of `finishSignUp`.
 *
 * On success the minted session tokens, otherwise a user-facing `userError`.
 */
export type FinishSignUpResult = Infer<typeof finishSignUpResult>;

const finishSignInResult = v.union(
  // `username` is the username of the account, as the user supplied it. The
  // client can pass it to the WebAuthn Signal API
  // (`PublicKeyCredential.signalCurrentUserDetails`) so the authenticator
  // shows a current name for the passkey.
  v.object({
    success: v.literal(true),
    tokens: vTokenBundle,
    username: v.string(),
  }),
  v.object({
    success: v.literal(false),
    userError: finishAuthenticationUserError,
  }),
);

/**
 * The result of `finishSignIn`.
 *
 * On success the minted session tokens, otherwise a user-facing `userError`.
 */
export type FinishSignInResult = Infer<typeof finishSignInResult>;

const changeUsernameResult = v.union(
  v.object({ success: v.literal(true), username: v.string() }),
  v.object({ success: v.literal(false), userError: setUsernameUserError }),
);

/** The result of `changeUsername`. */
export type ChangeUsernameResult = Infer<typeof changeUsernameResult>;

const startAddPasskeyResult = v.object({
  challenge: v.bytes(),
  userHandle: v.string(),
  excludeCredentials: v.array(v.bytes()),
});

/** The result of `startAddPasskey`. */
export type StartAddPasskeyResult = Infer<typeof startAddPasskeyResult>;

const finishAddPasskeyResult = v.union(
  v.object({ success: v.literal(true), passkeyId: v.string() }),
  v.object({
    success: v.literal(false),
    userError: finishRegistrationUserError,
  }),
);

/** The result of `finishAddPasskey`. */
export type FinishAddPasskeyResult = Infer<typeof finishAddPasskeyResult>;

const listPasskeysResult = v.array(
  v.object({
    passkeyId: v.string(),
    name: v.optional(v.string()),
    credentialId: v.bytes(),
    createdAt: v.number(),
  }),
);

const startDeletePasskeyResult = v.union(
  v.object({
    success: v.literal(true),
    challenge: v.bytes(),
    // The user's other credential IDs. The passkey that is marked for
    // deletion is not in the list, because it cannot approve its own
    // deletion.
    allowCredentials: v.array(v.bytes()),
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      v.object({ error: v.literal("PASSKEY_NOT_FOUND") }),
      // The user has no other passkey. Deletion of the last passkey is not
      // possible: it would lock the user out, and no recovery flow exists.
      v.object({ error: v.literal("NO_OTHER_PASSKEY") }),
    ),
  }),
);

/** The result of `startDeletePasskey`. */
export type StartDeletePasskeyResult = Infer<typeof startDeletePasskeyResult>;

const finishDeletePasskeyResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      finishAuthenticationUserError,
      // The assertion comes from the passkey that is marked for deletion.
      // A different passkey of the same user must approve the deletion.
      v.object({ error: v.literal("SAME_PASSKEY") }),
      v.object({ error: v.literal("PASSKEY_NOT_FOUND") }),
    ),
  }),
);

/** The result of `finishDeletePasskey`. */
export type FinishDeletePasskeyResult = Infer<typeof finishDeletePasskeyResult>;

/**
 * The username+passkey recipe: each account is a username, and passkeys are
 * the only way to sign in. There is no password, no email address, and no
 * recovery flow. A user that loses all passkeys loses the account.
 *
 * Wire it into `setupCore`:
 *
 * ```ts
 * setupCore({
 *   component: components.core,
 *   providers: [
 *     provider(UsernamePasskey, {
 *       component: components.authPasskey,
 *       usernameComponent: components.authUsername,
 *       rpId: "example.com",
 *       origin: "https://app.example.com",
 *     }),
 *   ],
 * }).attachUserCallback(internal.users.createOrUpdateUser);
 * ```
 *
 * The app re-exports the returned functions so its clients can call them.
 *
 * ## The sign-in flow
 *
 * The flow is identifier-first. The user enters a username, and the client
 * calls `startSignIn`:
 *
 * - When the username exists, the result is the `authenticate` step. The
 *   client runs `navigator.credentials.get` and calls `finishSignIn`.
 * - When the username is free, the provider creates a new empty user row
 *   and the result is the `register` step. The client runs
 *   `navigator.credentials.create` with the returned `userHandle` as
 *   `user.id`, and calls `finishSignUp`.
 *
 * The user row must exist before the ceremony, because the WebAuthn user
 * handle is the row id. The username becomes reserved only when
 * `finishSignUp` succeeds. Two consequences are accepted by design:
 *
 * - An abandoned registration leaks an empty user row.
 * - A different person can take the username while the ceremony runs. In
 *   that case `finishSignUp` returns `USERNAME_TAKEN`, the challenge stays
 *   valid, and the client can send the same ceremony result again with a
 *   different username.
 *
 * ## The app's `createOrUpdateUser` contract
 *
 * The app's callback must handle three call shapes:
 *
 * 1. No arguments: create a new empty user row and return its id.
 * 2. `userId: null` with `profile.existingUserId`: return that id. The
 *    provider created the row in shape 1, and the first sign-in must not
 *    create a second row. The value is trusted: it comes from the
 *    provider, not from the client.
 * 3. `userId` set: update the user record from `profile` (for example,
 *    store `profile.username`) and return the same id.
 *
 * ## Management functions
 *
 * A signed-in user can change their username, add a passkey, list their
 * passkeys, and delete a passkey. Deletion demands a fresh assertion from
 * a *different* passkey of the same user, so the last passkey can never be
 * deleted. There are no security notifications: the account has no
 * out-of-band contact method.
 *
 * Account resolution (username → app user id) is owned by the username
 * component: the provider stores the username there at sign-up, and reads
 * the user id back from it at sign-in. The provider account id in the
 * core's `accounts` table is the app user id itself: a stable, opaque
 * value that a username change does not touch. The passkey component
 * itself stores only opaque user ids and knows nothing about usernames.
 */
export const UsernamePasskey = defineProvider({
  name: PROVIDER_NAME,
  setup: (
    { completeSignIn, createOrUpdateUser },
    options: UsernamePasskeyOptions,
  ) => {
    const { component, usernameComponent, rpId, origin } = options;

    return {
      /**
       * Start the identifier-first flow for a username. See the comment on
       * {@link UsernamePasskey} for the two branches. The `register` branch
       * creates an empty user row; an abandoned ceremony leaks that row,
       * which is accepted by design.
       */
      startSignIn: mutationGeneric({
        args: { username: v.string() },
        returns: startSignInResult,
        handler: async (ctx, { username }): Promise<StartSignInResult> => {
          const existingUserId = await ctx.runQuery(
            usernameComponent.public.getUserIdByUsername,
            { username },
          );
          if (existingUserId !== null) {
            const { challenge, allowCredentials } = await ctx.runMutation(
              component.authentication.startAuthentication,
              { userId: existingUserId },
            );
            return { step: "authenticate", challenge, allowCredentials };
          }
          // The username is free. Create the user row now: the row id is
          // the WebAuthn user handle, and Convex mints ids only on insert.
          // The username is not reserved yet; `finishSignUp` reserves it.
          const userId = await createOrUpdateUser(ctx);
          const { challenge, excludeCredentials } = await ctx.runMutation(
            component.registration.startRegistration,
            { userId },
          );
          return {
            step: "register",
            challenge,
            userHandle: userId,
            excludeCredentials,
          };
        },
      }),

      /**
       * Finish a sign-up ceremony: examine the attestation, store the
       * passkey, reserve the username, and mint a session.
       *
       * The whole step is one mutation, so it is atomic. On
       * `USERNAME_TAKEN` nothing is stored and the challenge stays valid:
       * the client can send the same ceremony result again with a
       * different username.
       */
      finishSignUp: mutationGeneric({
        args: {
          username: v.string(),
          name: v.optional(v.string()),
          attestationObject: v.bytes(),
          clientDataJSON: v.bytes(),
        },
        returns: finishSignUpResult,
        handler: async (ctx, args): Promise<FinishSignUpResult> => {
          // Check the username before the ceremony result is examined, so
          // an invalid or taken username does not burn the challenge.
          const usernameError = validateUsernameFormat(args.username);
          if (usernameError !== null) {
            return { success: false, userError: usernameError };
          }
          const takenBy = await ctx.runQuery(
            usernameComponent.public.getUserIdByUsername,
            { username: args.username },
          );
          if (takenBy !== null) {
            return { success: false, userError: { error: "USERNAME_TAKEN" } };
          }

          const result = await ctx.runMutation(
            component.registration.finishRegistration,
            {
              expectedRpId: rpId,
              expectedOrigin: origin,
              name: args.name,
              attestationObject: args.attestationObject,
              clientDataJSON: args.clientDataJSON,
            },
          );
          if (!result.success) {
            return { success: false, userError: result.userError };
          }
          // The challenge supplied the trusted owner of the new passkey:
          // the user row that `startSignIn` created.
          const userId = result.userId;
          const existingUsername = await ctx.runQuery(
            usernameComponent.public.getUsername,
            { userId },
          );
          if (existingUsername !== null) {
            // The challenge belongs to a user that already has a username
            // (an add-passkey challenge sent to the wrong function). A
            // correct client cannot cause this. The error rolls the whole
            // mutation back, including the stored passkey.
            throw new Error(
              "The user of this registration challenge already has a username.",
            );
          }

          // Reserve the username.
          const setUsernameResult = await ctx.runMutation(
            usernameComponent.public.setUsername,
            { userId, username: args.username },
          );
          if (!setUsernameResult.success) {
            // Unexpected: the format and the conflict were checked above,
            // and this handler is a mutation, thus the checks and this call
            // are in the same transaction. Throwing so that the transaction
            // doesn't commit.
            throw new Error(
              "Unexpected error when setting the username: " +
                setUsernameResult.userError.error,
              { cause: setUsernameResult.userError },
            );
          }

          // Mint the session. The provider account id is the app user id:
          // the username component owns the username → user id mapping.
          // `existingUserId` makes the app's callback reuse the row from
          // `startSignIn` instead of creating a second user.
          const tokens = await completeSignIn(ctx, {
            provider: PROVIDER_NAME,
            providerAccountId: userId,
            profile: { username: args.username, existingUserId: userId },
          });
          if (tokens.userId !== userId) {
            // The app's callback did not honor `profile.existingUserId`.
            // Roll everything back instead of splitting the account across
            // two user rows.
            throw new Error(
              "createOrUpdateUser must return profile.existingUserId for the passkey provider.",
            );
          }
          return { success: true, tokens, username: args.username };
        },
      }),

      /**
       * Finish an authentication ceremony and mint a session. The
       * component identifies the user from the credential; the username in
       * the result comes from the user's account row.
       */
      finishSignIn: mutationGeneric({
        args: {
          credentialId: v.bytes(),
          authenticatorData: v.bytes(),
          clientDataJSON: v.bytes(),
          signature: v.bytes(),
        },
        returns: finishSignInResult,
        handler: async (ctx, args): Promise<FinishSignInResult> => {
          const result = await ctx.runMutation(
            component.authentication.finishAuthentication,
            {
              expectedRpId: rpId,
              expectedOrigin: origin,
              credentialId: args.credentialId,
              authenticatorData: args.authenticatorData,
              clientDataJSON: args.clientDataJSON,
              signature: args.signature,
            },
          );
          if (!result.success) {
            return { success: false, userError: result.userError };
          }
          const username = await ctx.runQuery(
            usernameComponent.public.getUsername,
            { userId: result.userId },
          );
          if (username === null) {
            // A passkey exists, but its user has no username. This state
            // is not reachable through this provider: `startSignIn` binds
            // authentication challenges only to users that have a
            // username.
            throw new Error("The passkey's user has no username.");
          }
          const tokens = await completeSignIn(ctx, {
            provider: PROVIDER_NAME,
            providerAccountId: result.userId,
            profile: { username },
          });
          return { success: true, tokens, username };
        },
      }),

      /**
       * Change the signed-in user's username. The account keeps its
       * sessions and its passkeys; only the username changes.
       *
       * After a success, the client should pass the new username to the
       * WebAuthn Signal API, so the user's authenticators show the current
       * name.
       */
      changeUsername: mutationGeneric({
        args: { newUsername: v.string() },
        returns: changeUsernameResult,
        handler: async (
          ctx,
          { newUsername },
        ): Promise<ChangeUsernameResult> => {
          const userId = await requireUserId(ctx);
          const setUsernameResult = await ctx.runMutation(
            usernameComponent.public.setUsername,
            { userId, username: newUsername },
          );
          if (!setUsernameResult.success) {
            return { success: false, userError: setUsernameResult.userError };
          }
          // Tell the app about the new username, so it can update its own
          // user record.
          const returnedUserId = await createOrUpdateUser(ctx, {
            provider: PROVIDER_NAME,
            providerAccountId: userId,
            profile: { username: newUsername },
            userId,
          });
          if (returnedUserId !== userId) {
            throw new Error(
              "createOrUpdateUser may not return a new userId for an existing user",
            );
          }
          return { success: true, username: newUsername };
        },
      }),

      /**
       * Start a ceremony that adds a passkey to the signed-in user's
       * account. The client runs `navigator.credentials.create` with the
       * returned `userHandle` as `user.id` and calls `finishAddPasskey`.
       */
      startAddPasskey: mutationGeneric({
        args: {},
        returns: startAddPasskeyResult,
        handler: async (ctx): Promise<StartAddPasskeyResult> => {
          const userId = await requireUserId(ctx);
          const { challenge, excludeCredentials } = await ctx.runMutation(
            component.registration.startRegistration,
            { userId },
          );
          return { challenge, excludeCredentials, userHandle: userId };
        },
      }),

      /**
       * Finish a ceremony that adds a passkey to the signed-in user's
       * account.
       */
      finishAddPasskey: mutationGeneric({
        args: {
          name: v.optional(v.string()),
          attestationObject: v.bytes(),
          clientDataJSON: v.bytes(),
        },
        returns: finishAddPasskeyResult,
        handler: async (ctx, args): Promise<FinishAddPasskeyResult> => {
          const userId = await requireUserId(ctx);
          const result = await ctx.runMutation(
            component.registration.finishRegistration,
            {
              expectedRpId: rpId,
              expectedOrigin: origin,
              name: args.name,
              attestationObject: args.attestationObject,
              clientDataJSON: args.clientDataJSON,
            },
          );
          if (!result.success) {
            return { success: false, userError: result.userError };
          }
          if (result.userId !== userId) {
            // The challenge belongs to a different user. A correct client
            // cannot cause this. The error rolls the mutation back,
            // including the stored passkey.
            throw new Error(
              "The registration challenge belongs to a different user.",
            );
          }
          return { success: true, passkeyId: result.passkeyId };
        },
      }),

      /**
       * List the signed-in user's passkeys, for example for a settings
       * page. The result contains only public metadata.
       */
      listPasskeys: queryGeneric({
        args: {},
        returns: listPasskeysResult,
        handler: async (ctx) => {
          const userId = await requireUserId(ctx);
          return await ctx.runQuery(component.registration.listPasskeys, {
            userId,
          });
        },
      }),

      /**
       * Start the deletion of one of the signed-in user's passkeys.
       *
       * A deletion demands a fresh assertion from a *different* passkey of
       * the same user, so `allowCredentials` does not contain the marked
       * passkey. A user with a single passkey gets `NO_OTHER_PASSKEY`: the
       * last passkey can never be deleted, because no recovery flow
       * exists.
       */
      startDeletePasskey: mutationGeneric({
        args: { passkeyId: v.string() },
        returns: startDeletePasskeyResult,
        handler: async (
          ctx,
          { passkeyId },
        ): Promise<StartDeletePasskeyResult> => {
          const userId = await requireUserId(ctx);
          const passkeys = await ctx.runQuery(
            component.registration.listPasskeys,
            { userId },
          );
          const target = passkeys.find(
            (passkey) => passkey.passkeyId === passkeyId,
          );
          if (target === undefined) {
            return {
              success: false,
              userError: { error: "PASSKEY_NOT_FOUND" },
            };
          }
          const others = passkeys.filter(
            (passkey) => passkey.passkeyId !== passkeyId,
          );
          if (others.length === 0) {
            return {
              success: false,
              userError: { error: "NO_OTHER_PASSKEY" },
            };
          }
          const { challenge } = await ctx.runMutation(
            component.authentication.startAuthentication,
            { userId },
          );
          return {
            success: true,
            challenge,
            allowCredentials: others.map((passkey) => passkey.credentialId),
          };
        },
      }),

      /**
       * Finish the deletion of a passkey. The assertion must come from a
       * different passkey of the signed-in user (see
       * `startDeletePasskey`).
       */
      finishDeletePasskey: mutationGeneric({
        args: {
          passkeyId: v.string(),
          credentialId: v.bytes(),
          authenticatorData: v.bytes(),
          clientDataJSON: v.bytes(),
          signature: v.bytes(),
        },
        returns: finishDeletePasskeyResult,
        handler: async (ctx, args): Promise<FinishDeletePasskeyResult> => {
          const userId = await requireUserId(ctx);
          const result = await ctx.runMutation(
            component.authentication.finishAuthentication,
            {
              expectedRpId: rpId,
              expectedOrigin: origin,
              credentialId: args.credentialId,
              authenticatorData: args.authenticatorData,
              clientDataJSON: args.clientDataJSON,
              signature: args.signature,
            },
          );
          if (!result.success) {
            return { success: false, userError: result.userError };
          }
          if (result.userId !== userId) {
            // The assertion comes from a passkey of a different user.
            return {
              success: false,
              userError: { error: "VERIFICATION_FAILED" },
            };
          }
          if (result.passkeyId === args.passkeyId) {
            return { success: false, userError: { error: "SAME_PASSKEY" } };
          }
          return await ctx.runMutation(component.registration.deletePasskey, {
            userId,
            passkeyId: args.passkeyId,
          });
        },
      }),
    };
  },
});
