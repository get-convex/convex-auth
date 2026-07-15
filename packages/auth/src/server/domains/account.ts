import { Auth, GenericActionCtx, GenericDataModel } from "convex/server";
import { ConvexError } from "convex/values";

import { ErrorCode } from "../../shared/codes";
import type { ComponentCtx, ComponentReadCtx } from "../component/context";
import { configDefaults } from "../config";
import { getSessionUserId } from "../context";
import { authDb } from "../db";
import { emitAuthEvent } from "../events";
import type { AuthProfile } from "../payloads";
import type { Doc } from "../types";

type AccountCredentials = { id: string; secret?: string };
type CreateAccountArgs = {
  provider: string;
  account: AccountCredentials;
  profile: AuthProfile;
  shouldLinkViaEmail?: boolean;
  shouldLinkViaPhone?: boolean;
};
type RetrieveAccountArgs = { provider: string; account: AccountCredentials };
type UpdateAccountCredentialsArgs = {
  provider: string;
  account: { id: string; secret: string };
};
type CredentialsAccountResult = {
  account: { _id: string; userId: string; secret?: string | null };
  user: Record<string, unknown>;
};

export type AccountDeps = {
  config: ReturnType<typeof configDefaults>;
  callCreateAccountFromCredentials: <DataModel extends GenericDataModel>(
    ctx: GenericActionCtx<DataModel>,
    args: CreateAccountArgs,
  ) => Promise<CredentialsAccountResult>;
  callRetrieveAccountWithCredentials: <DataModel extends GenericDataModel>(
    ctx: GenericActionCtx<DataModel>,
    args: RetrieveAccountArgs,
  ) => Promise<
    CredentialsAccountResult | "InvalidAccountId" | "InvalidSecret" | "TooManyFailedAttempts"
  >;
  callModifyAccount: <DataModel extends GenericDataModel>(
    ctx: GenericActionCtx<DataModel>,
    args: UpdateAccountCredentialsArgs,
  ) => Promise<void>;
};

export function createAccountDomain(deps: AccountDeps) {
  const {
    config,
    callCreateAccountFromCredentials,
    callRetrieveAccountWithCredentials,
    callModifyAccount,
  } = deps;

  return {
    /**
     * Create a new auth account linked to a user.
     *
     * Creates a credentials-based account record for a given provider. If
     * the user does not yet exist, one is created from the supplied
     * `profile`. If `shouldLinkViaEmail` or `shouldLinkViaPhone` is set,
     * the account may be linked to an existing user whose email or phone
     * matches the profile.
     *
     * The `account.secret` (e.g. a hashed password) is optional and
     * depends on the provider type.
     *
     * @param ctx - Convex action context.
     * @param args.provider - The provider ID (e.g. `"password"`, `"credentials"`).
     * @param args.account.id - Provider-specific account identifier (e.g. email address).
     * @param args.account.secret - Optional credential secret (e.g. hashed password).
     * @param args.profile - Profile data used to create or update the user document.
     * @param args.shouldLinkViaEmail - If `true`, link to an existing user by email match.
     * @param args.shouldLinkViaPhone - If `true`, link to an existing user by phone match.
     * @returns The created account and user information.
     *
     * @example
     * ```ts
     * const result = await auth.account.create(ctx, {
     *   provider: "password",
     *   account: { id: "alice@example.com", secret: hashedPassword },
     *   profile: { email: "alice@example.com", name: "Alice" },
     * });
     * ```
     */
    create: async <DataModel extends GenericDataModel>(
      ctx: GenericActionCtx<DataModel>,
      args: CreateAccountArgs,
    ) => {
      const created = await callCreateAccountFromCredentials(ctx, args);
      return { ...created };
    },
    /**
     * Retrieve an auth account by provider and credentials.
     *
     * Looks up an account matching the given provider and account ID,
     * optionally verifying the secret (e.g. password). If the account
     * exists and the credentials are valid, the full account document is
     * returned. Returns `null` if no matching account is found or if the
     * credential verification fails (indicated by a string error from the
     * underlying RPC).
     *
     * @param ctx - Convex action context.
     * @param args.provider - The provider ID (e.g. `"password"`).
     * @param args.account.id - Provider-specific account identifier.
     * @param args.account.secret - Optional credential secret to verify.
     * @returns The account document, or `null` if not found or verification failed.
     *
     * @example
     * ```ts
     * const acct = await auth.account.get(ctx, {
     *   provider: "password",
     *   account: { id: "alice@example.com", secret: plainTextPassword },
     * });
     * if (!acct) throw new Error("Invalid credentials");
     * ```
     */
    get: async <DataModel extends GenericDataModel>(
      ctx: GenericActionCtx<DataModel>,
      args: RetrieveAccountArgs,
    ) => {
      const result = await callRetrieveAccountWithCredentials(ctx, args);
      if (typeof result === "string") {
        return null;
      }
      return result;
    },
    /**
     * Update the credentials (secret) for an existing auth account.
     *
     * Replaces the stored secret for the account identified by `provider`
     * and `account.id`. This is the standard path for password changes
     * and password resets — the new secret is typically a freshly hashed
     * password.
     *
     * @param ctx - Convex action context.
     * @param args.provider - The provider ID (e.g. `"password"`).
     * @param args.account.id - Provider-specific account identifier.
     * @param args.account.secret - The new credential secret to store.
     * @returns `{ accountId }` confirming the update.
     *
     * @example Password reset
     * ```ts
     * await auth.account.update(ctx, {
     *   provider: "password",
     *   account: { id: "alice@example.com", secret: newHashedPassword },
     * });
     * ```
     */
    update: async <DataModel extends GenericDataModel>(
      ctx: GenericActionCtx<DataModel>,
      args: UpdateAccountCredentialsArgs,
    ) => {
      await callModifyAccount(ctx, args);
      return { accountId: args.account.id };
    },
    /**
     * Delete an auth account by ID.
     *
     * Removes the account record from the database. As a safety measure,
     * deletion is **refused** if this is the user's only remaining account
     * — the user must always have at least one linked account. If the
     * account is not found, returns an error result instead of throwing.
     *
     * @param ctx - Convex mutation context.
     * @param args.id - The account's document ID.
     * @returns `{ accountId }` on success.
     * @throws `ACCOUNT_NOT_FOUND` if the account does not exist.
     * @throws `INVALID_PARAMETERS` if it is the user's last account.
     *
     * @example
     * ```ts
     * await auth.account.remove(ctx, { id: accountId });
     * ```
     */
    remove: async (ctx: ComponentCtx, args: { id: string }) => {
      await ctx.runMutation(config.component.account.remove, {
        id: args.id,
        requireOtherAccount: true,
      });
      return { accountId: args.id };
    },
    /**
     * Attach a new provider account to the current authenticated user.
     *
     * Idempotent: linking the same `(provider, providerAccountId)` to the
     * same user is a no-op. Linking a `(provider, providerAccountId)` that
     * already belongs to a different user throws `ACCOUNT_ALREADY_LINKED`.
     *
     * When the current user is anonymous (`isAnonymous: true`), this also
     * flips `isAnonymous: false` and merges the supplied profile fields
     * (`name`, `image`, `email`) into the user document — folding in the
     * "upgrade anonymous to permanent account" flow under one verb.
     *
     * Emits a `user.updated` auth event on success.
     *
     * @param ctx - Convex mutation context with `auth`.
     * @param args.provider - Provider id (e.g. `"google"`, `"github"`).
     * @param args.profile - Provider profile. Must include `id` (provider
     *   account id) or `email`/`phone`. Optional `name`, `image`, `email`
     *   are merged into the user when upgrading from anonymous.
     * @returns `{ accountId, userId, alreadyLinked }`.
     * @throws `NOT_SIGNED_IN` if no current user.
     * @throws `ACCOUNT_ALREADY_LINKED` if the provider account belongs to
     *   a different user.
     *
     * @example Link Google after the user signed in with password
     * ```ts
     * await auth.account.link(ctx, {
     *   provider: "google",
     *   profile: { id: googleSub, email, name, image },
     * });
     * ```
     */
    link: async (
      ctx: ComponentCtx & { auth: Auth },
      args: {
        provider: string;
        profile: { id?: string; email?: string; phone?: string; name?: string; image?: string };
      },
    ): Promise<{ accountId: string; userId: string; alreadyLinked: boolean }> => {
      const userId = await getSessionUserId(ctx);
      if (userId === null) {
        throw new ConvexError({
          code: ErrorCode.NOT_SIGNED_IN,
          message: "Must be authenticated to link an account.",
        });
      }
      const providerAccountId = args.profile.id ?? args.profile.email ?? args.profile.phone ?? null;
      if (providerAccountId === null) {
        throw new ConvexError({
          code: ErrorCode.INVALID_PARAMETERS,
          message: "args.profile must include `id`, `email`, or `phone` for account linking.",
        });
      }
      const db = authDb(ctx, config);
      const existing = await db.accounts.get({
        provider: args.provider,
        providerAccountId,
      });
      if (existing !== null) {
        if (existing.userId === userId) {
          return {
            accountId: existing._id,
            userId,
            alreadyLinked: true,
          };
        }
        throw new ConvexError({
          code: ErrorCode.ACCOUNT_ALREADY_LINKED,
          message: "Provider account is already linked to a different user.",
          provider: args.provider,
        });
      }
      const accountId = await db.accounts.create({
        userId,
        provider: args.provider,
        providerAccountId,
      });
      const user = await db.users.get({ id: userId });
      if (user?.isAnonymous === true) {
        const patchData: Record<string, unknown> = { isAnonymous: false };
        if (typeof args.profile.name === "string") patchData.name = args.profile.name;
        if (typeof args.profile.email === "string") patchData.email = args.profile.email;
        if (typeof args.profile.image === "string") patchData.image = args.profile.image;
        await db.users.update(userId, patchData);
      }
      await emitAuthEvent(ctx, config, {
        kind: "user.updated",
        actor: { type: "user", id: userId },
        subject: { type: "user", id: userId },
        targets: [{ kind: "user", id: userId }],
        outcome: "success",
        data: {
          type: "credentials",
          provider: args.provider,
          profile: args.profile,
        },
      });
      return { accountId, userId, alreadyLinked: false };
    },
    passkey: {
      /**
       * List all passkey credentials registered for a user.
       *
       * Returns every WebAuthn passkey credential associated with the given
       * `userId`. Each document includes the credential's public key,
       * metadata (such as a human-readable name), and counters used for
       * replay protection.
       *
       * @param ctx - Convex query or mutation context.
       * @param opts.userId - The user whose passkeys to list.
       * @returns An array of passkey credential documents.
       *
       * @example
       * ```ts
       * const passkeys = await auth.account.passkey.list(ctx, { userId });
       * for (const pk of passkeys) {
       *   console.log(pk.name ?? "Unnamed passkey", pk._id);
       * }
       * ```
       */
      list: async (ctx: ComponentReadCtx, opts: { userId: string }): Promise<Doc<"Passkey">[]> => {
        return (await ctx.runQuery(config.component.factor.passkey.list, opts)) as Doc<"Passkey">[];
      },
      /**
       * Update a passkey credential's metadata (e.g. rename it).
       *
       * Updates the human-readable `name` metadata on a passkey document.
       * Useful for letting users label their passkeys (e.g. "MacBook Pro",
       * "YubiKey 5").
       *
       * @param ctx - Convex mutation context.
       * @param args.id - The passkey credential's document ID.
       * @param args.patch.name - The new display name for the passkey.
       * @returns `{ passkeyId }` confirming the update.
       *
       * @example
       * ```ts
       * await auth.account.passkey.update(ctx, {
       *   id: passkeyId,
       *   patch: { name: "Work laptop" },
       * });
       * ```
       */
      update: async (ctx: ComponentCtx, args: { id: string; patch: { name: string } }) => {
        await ctx.runMutation(config.component.factor.passkey.update, {
          id: args.id,
          patch: args.patch,
        });
        return { passkeyId: args.id };
      },
      /**
       * Remove a passkey credential.
       *
       * Permanently removes a WebAuthn passkey credential from the database.
       * After removal, the physical authenticator associated with this
       * credential can no longer be used to sign in.
       *
       * @param ctx - Convex mutation context.
       * @param args.id - The passkey credential's document ID.
       * @returns `{ passkeyId }` confirming the removal.
       *
       * @example
       * ```ts
       * await auth.account.passkey.remove(ctx, { id: passkeyId });
       * ```
       */
      remove: async (ctx: ComponentCtx, args: { id: string }) => {
        await ctx.runMutation(config.component.factor.passkey.remove, {
          id: args.id,
        });
        return { passkeyId: args.id };
      },
    },
    totp: {
      /**
       * List all TOTP (time-based one-time password) factors for a user.
       *
       * Returns every TOTP authenticator factor registered for the given
       * `userId`. Each document includes the secret, issuer, and verification
       * metadata needed for two-factor authentication management UIs.
       *
       * @param ctx - Convex query or mutation context.
       * @param opts.userId - The user whose TOTP factors to list.
       * @returns An array of TOTP factor documents.
       *
       * @example
       * ```ts
       * const totps = await auth.account.totp.list(ctx, { userId });
       * const has2FA = totps.length > 0;
       * ```
       */
      list: async (
        ctx: ComponentReadCtx,
        opts: { userId: string },
      ): Promise<Doc<"TotpFactor">[]> => {
        return (await ctx.runQuery(config.component.factor.totp.list, opts)) as Doc<"TotpFactor">[];
      },
      /**
       * Remove a TOTP factor.
       *
       * Permanently removes a TOTP authenticator factor from the database.
       * After removal, codes generated by the corresponding authenticator
       * app will no longer be accepted for two-factor authentication.
       *
       * @param ctx - Convex mutation context.
       * @param args.id - The TOTP factor's document ID.
       * @returns `{ totpId }` confirming the removal.
       *
       * @example
       * ```ts
       * await auth.account.totp.remove(ctx, { id: totpId });
       * ```
       */
      remove: async (ctx: ComponentCtx, args: { id: string }) => {
        await ctx.runMutation(config.component.factor.totp.remove, { id: args.id });
        return { totpId: args.id };
      },
    },
  };
}
