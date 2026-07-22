import { Auth, GenericActionCtx, GenericDataModel } from "convex/server";
import { ConvexError, GenericId } from "convex/values";

import { ErrorCode } from "../shared/codes";
import type { ComponentCtx, ComponentReadCtx } from "./component/context";
import { configDefaults } from "./config";
import { createOAuthClientDomain } from "./oauth/client";
import { createOAuthCodeDomain } from "./oauth/code";
import { createOAuthRefreshDomain } from "./oauth/refresh";
import type { OAuthRuntimeDomain } from "./oauth/domain";
import { getSessionUserId } from "./context";
import { createSessionDomain } from "./domains/session";
import { createKeyDomain } from "./domains/key";
import { createInviteDomain } from "./domains/invite";
import { createMemberDomain } from "./domains/member";
import { createAccountDomain } from "./domains/account";
import { createUserDomain } from "./domains/user";
import { createGroupDomain } from "./domains/group";
import type { AuthProviderConfig, Doc } from "./types";
import type { SignInParams } from "./payloads";
import type { SignInFlowResult } from "../shared/results";

type ComponentAuthReadCtx = ComponentReadCtx & { auth: Auth };

type CreateAccountArgs = {
  provider: string;
  account: { id: string; secret?: string };
  profile: import("./payloads").AuthProfile;
  shouldLinkViaEmail?: boolean;
  shouldLinkViaPhone?: boolean;
};
type RetrieveAccountArgs = { provider: string; account: { id: string; secret?: string } };
type UpdateAccountCredentialsArgs = {
  provider: string;
  account: { id: string; secret: string };
};
type CredentialsAccountResult = {
  account: { _id: string; userId: string; secret?: string | null };
  user: Record<string, unknown>;
};
type ProviderImmediateSignInResult = { userId: string; sessionId: string };
type ProviderDeferredSignInResult = Exclude<SignInFlowResult<null>, { kind: "signedIn" }>;
type ProviderSignInResult = ProviderImmediateSignInResult | ProviderDeferredSignInResult | null;

type CoreDeps = {
  config: ReturnType<typeof configDefaults>;
  callInvalidateSessions: <DataModel extends GenericDataModel>(
    ctx: GenericActionCtx<DataModel>,
    args: { userId: GenericId<"User">; except?: GenericId<"Session">[] },
  ) => Promise<void>;
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
  getEnrichCtx: () => <DataModel extends GenericDataModel>(
    ctx: GenericActionCtx<DataModel>,
  ) => GenericActionCtx<DataModel>;
  inviteTokenAlphabet: string;
  inviteTokenLength: number;
  signInForProvider?: <DataModel extends GenericDataModel>(
    ctx: GenericActionCtx<DataModel>,
    providerConfig: AuthProviderConfig,
    args: {
      accountId?: GenericId<"Account">;
      params?: SignInParams;
    },
  ) => Promise<ProviderSignInResult>;
};

/**
 * Build the core auth domains that back the canonical app API surface.
 *
 * Creates the grouped `user`, `session`, `account`, `provider`, `group`,
 * `member`, `invite`, and `key` APIs used by the higher-level auth
 * factory. Each namespace wraps the underlying Convex component functions with
 * application-friendly helpers, result shaping, and documentation-friendly
 * method names.
 *
 * @param deps - Internal component wiring, provider config, and helper
 *   functions needed to construct the domain API surface.
 * @returns The core domain namespaces consumed by the auth factory.
 */
export function createCoreDomains(deps: CoreDeps) {
  const {
    config,
    callInvalidateSessions,
    callCreateAccountFromCredentials,
    callRetrieveAccountWithCredentials,
    callModifyAccount,
    inviteTokenAlphabet,
    inviteTokenLength,
  } = deps;

  const roleDefinitions = config.permissions.roles as Record<
    string,
    { label?: string; grants: string[] }
  >;

  const getRoleDefinition = (roleId: string) => {
    return roleDefinitions[roleId] ?? null;
  };

  const normalizeRoleIds = (roleIds?: string[]): string[] => {
    const normalized = Array.from(new Set(roleIds ?? []));
    const invalid = normalized.filter((id) => getRoleDefinition(id) === null);
    if (invalid.length > 0) {
      throw new ConvexError({
        code: ErrorCode.INVALID_ROLE_IDS,
        message: "One or more role IDs are invalid.",
        invalidRoleIds: invalid,
      });
    }
    return normalized;
  };

  const resolveGrantedPermissions = (roleIds?: string[]) => {
    const grants = new Set<string>();
    for (const roleId of roleIds ?? []) {
      const role = getRoleDefinition(roleId);
      if (role === null) continue;
      for (const grant of role.grants) {
        grants.add(grant);
      }
    }
    return Array.from(grants).sort();
  };

  const session = createSessionDomain({ config, callInvalidateSessions });
  const key = createKeyDomain({ config });
  const user = createUserDomain({ config });
  const groupDomain = createGroupDomain({ config });
  const member = createMemberDomain({
    config,
    normalizeRoleIds,
    resolveGrantedPermissions,
    groupGet: groupDomain.groupGet,
  });
  const invite = createInviteDomain({
    config,
    inviteTokenAlphabet,
    inviteTokenLength,
    normalizeRoleIds,
  });
  const account = createAccountDomain({
    config,
    callCreateAccountFromCredentials,
    callRetrieveAccountWithCredentials,
    callModifyAccount,
  });

  const { groupGet: _groupGet, ...group } = groupDomain;

  const provider = {
    /**
     * Sign in through a specific provider from server-side code.
     *
     * Materializes the supplied provider config, runs the standard sign-in
     * flow, and returns the resulting `userId` and `sessionId` when the
     * provider completes authentication immediately. Returns `null` for
     * providers that require additional client-side steps (for example
     * redirects, email verification, or other non-immediate flows).
     *
     * This helper is useful for trusted server flows where you already know
     * which provider should handle the sign-in and want the same behavior as
     * the public auth API without generating tokens for the client.
     *
     * @param ctx - Convex action context.
     * @param providerConfig - Provider configuration object to materialize and use.
     * @param args.accountId - Optional account document ID to sign in with directly.
     * @param args.params - Optional provider-specific parameters forwarded to the sign-in flow.
     * @returns `{ userId, sessionId }` when sign-in succeeds immediately, or `null`
     *   when the provider does not produce an immediate session.
     *
     * @example
     * ```ts
     * const session = await auth.provider.signIn(ctx, passwordProvider, {
     *   params: { email: "alice@example.com", password: "secret" },
     * });
     *
     * if (!session) {
     *   throw new Error("Provider requires another auth step");
     * }
     * ```
     */
    signIn: deps.signInForProvider
      ? async <DataModel extends GenericDataModel>(
          ctx: GenericActionCtx<DataModel>,
          providerConfig: AuthProviderConfig,
          args: {
            accountId?: GenericId<"Account">;
            params?: SignInParams;
          },
        ) => {
          return deps.signInForProvider!(ctx, providerConfig, args);
        }
      : undefined,
  };

  const readLastActiveGroup = (doc: Doc<"User"> | null): string | null => {
    const val = doc?.lastActiveGroup;
    return typeof val === "string" ? val : null;
  };

  /**
   * The current user's active group — the workspace selection persisted
   * natively on `User.lastActiveGroup`. Exposes `get` / `update` / `remove`
   * instead of bespoke `setActiveGroup`/`getActiveGroup`.
   */
  const active = {
    /**
     * Resolve the *effective* active group: the stored selection if it is
     * still a current membership, otherwise the user's first membership.
     *
     * @param ctx - Convex query/mutation context with `auth`.
     * @param opts.userId - Target user; defaults to the current session user.
     * @returns `{ groupId, group, membership }`, or `null` when there is no
     *   authenticated user or the user has no memberships.
     *
     * @example
     * ```ts
     * const active = await auth.group.active.get(ctx);
     * if (active) console.log(active.group.name);
     * ```
     */
    get: async (
      ctx: ComponentAuthReadCtx,
      opts?: { userId?: string },
    ): Promise<{
      groupId: string;
      group: Doc<"Group"> | null;
      membership: Doc<"GroupMember">;
    } | null> => {
      const userId = opts?.userId ?? (await getSessionUserId(ctx));
      if (userId === null || userId === undefined) return null;
      const [userDoc, { page: memberships }] = await Promise.all([
        user.get(ctx, { id: userId }),
        member.list(ctx, {
          where: { userId },
          paginationOpts: { numItems: 100, cursor: null },
        }),
      ]);
      if (memberships.length === 0) return null;
      const stored = readLastActiveGroup(userDoc);
      const chosen =
        memberships.find((m: Doc<"GroupMember">) => m.groupId === stored) ?? memberships[0];
      const groupDoc = await group.get(ctx, { id: chosen.groupId });
      return { groupId: chosen.groupId, group: groupDoc, membership: chosen };
    },
    /**
     * Update the active group, validating the user is a member first.
     *
     * @param ctx - Convex mutation context with `auth`.
     * @param groupId - Group to activate.
     * @param opts.userId - Target user; defaults to the current session user.
     * @throws `NOT_SIGNED_IN` if no user, `NOT_A_MEMBER` if not a member.
     */
    update: async (
      ctx: ComponentCtx & { auth: Auth },
      groupId: string,
      opts?: { userId?: string },
    ): Promise<{ groupId: string }> => {
      const userId = opts?.userId ?? (await getSessionUserId(ctx));
      if (userId === null || userId === undefined) {
        throw new ConvexError({
          code: ErrorCode.NOT_SIGNED_IN,
          message: "Authentication required.",
        });
      }
      const { page } = await member.list(ctx, {
        where: { userId, groupId },
        paginationOpts: { numItems: 1, cursor: null },
      });
      if (page.length === 0) {
        throw new ConvexError({
          code: ErrorCode.NOT_A_MEMBER,
          message: "User is not a member of this group.",
        });
      }
      await user.update(ctx, { id: userId, patch: { lastActiveGroup: groupId } });
      return { groupId };
    },
    /**
     * Remove the stored active group selection.
     *
     * @param ctx - Convex mutation context with `auth`.
     * @param opts.userId - Target user; defaults to the current session user.
     */
    remove: async (
      ctx: ComponentCtx & { auth: Auth },
      opts?: { userId?: string },
    ): Promise<{ groupId: null }> => {
      const userId = opts?.userId ?? (await getSessionUserId(ctx));
      if (userId === null || userId === undefined) {
        throw new ConvexError({
          code: ErrorCode.NOT_SIGNED_IN,
          message: "Authentication required.",
        });
      }
      await user.update(ctx, {
        id: userId,
        patch: { lastActiveGroup: undefined },
      });
      return { groupId: null };
    },
  };

  const oauthClient = createOAuthClientDomain({
    component: config.component,
    events: config.events,
  });
  const oauthCode = createOAuthCodeDomain({
    component: config.component,
    events: config.events,
  });
  const oauthRefresh = createOAuthRefreshDomain({
    component: config.component,
    events: config.events,
  });

  const oauth: OAuthRuntimeDomain = {
    client: oauthClient,
    code: oauthCode,
    refresh: oauthRefresh,
    authorize: (ctx, args) => oauthCode.authorize(ctx, args),
  };

  return {
    user,
    session,
    account,
    provider,
    group,
    member,
    invite,
    key,
    active,
    oauth,
  };
}
