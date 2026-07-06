import type { UserIdentity } from "convex/server";
import { ConvexError, type GenericId } from "convex/values";

import { ErrorCode } from "../shared/codes";
import type { ComponentReadCtx as AuthQueryCtx } from "./component/context";
import type { Doc } from "./types";
import {
  getAuthenticatedUserIdOrNull,
  getUserIdentityOrNull,
  oauthScopesFromIdentity,
  userIdFromIdentity,
} from "./identity/claims";

/** Canonical user document type exposed by Convex Auth. */
export type UserDoc = Doc<"User">;

type AuthIdentityCtx = {
  auth: {
    getUserIdentity: () => Promise<UserIdentity | null>;
  };
};

/**
 * Current request auth context injected into `ctx.auth` by `auth.ctx()`. This
 * is the authenticated auth shape returned by {@link defineAuth().context}.
 * Optional context builders may still surface nullable fields when
 * `optional: true` is used.
 *
 * - `groupId` is `null` when the user has no active group set.
 * - `role` is `null` when no active group or no membership is resolved.
 * - `grants` is `[]` when no active group or no membership is resolved.
 *
 * @example
 * ```ts
 * import type { AuthContext } from "@robelest/convex-auth/server";
 *
 * const mockAuth: AuthContext = {
 *   userId: "user123" as Id<"User">,
 *   user: { _id: "user123", email: "test@example.com" },
 *   groupId: "group456",
 *   role: "admin",
 *   grants: ["read", "write"],
 * };
 * ```
 */
export type AuthContext = {
  /** The authenticated user's document ID. */
  userId: GenericId<"User">;
  /** The authenticated user's full document. */
  user: UserDoc;
  /** The user's active group ID, or `null` if none set. */
  groupId: string | null;
  /** The user's primary role in the active group, or `null`. */
  role: string | null;
  /** Resolved grant strings from the user's role definitions. */
  grants: string[];
  /**
   * Assert the current user holds the given grant(s); throws
   * `ConvexError({ code: ErrorCode.MISSING_GRANTS })` otherwise. Pass a
   * group-owned document as the second argument to also assert the
   * record belongs to the active group (`code: ErrorCode.FORBIDDEN` if not).
   *
   * For a boolean check, read `grants` directly:
   * `ctx.auth.grants.includes("issues.read")`.
   *
   * @example
   * ```ts
   * ctx.auth.assert("members.manage");
   * ctx.auth.assert(["issues.edit", "issues.move"]);
   * ctx.auth.assert("issues.edit", issueDoc); // group-scoped
   * ```
   */
  assert: (grant: string | readonly string[], doc?: { groupId?: unknown }) => void;
};

/**
 * Nullable auth context returned by `auth.context.optional(ctx)` and injected
 * by `auth.ctx.optional()`.
 *
 * Use this when callers may be unauthenticated but you still want a stable
 * auth-shaped object.
 *
 * - `userId` and `user` are `null` when unauthenticated.
 * - `groupId` and `role` are `null` when no active group is resolved.
 * - `grants` is `[]` when no membership is resolved.
 *
 * @example
 * ```ts
 * const authContext = await auth.context.optional(ctx);
 * if (authContext.userId === null) {
 *   return null;
 * }
 * ```
 */
export type OptionalAuthContext = {
  /** The authenticated user's document ID, or `null` when unauthenticated. */
  userId: GenericId<"User"> | null;
  /** The authenticated user's full document, or `null` when unauthenticated. */
  user: UserDoc | null;
  /** The user's active group ID, or `null` if none is set. */
  groupId: string | null;
  /** The user's primary role in the active group, or `null`. */
  role: string | null;
  /** Resolved grant strings for the active membership, or `[]`. */
  grants: string[];
  /**
   * Assert the current user holds the given grant(s); throws when
   * missing (or, with a group-owned `doc`, when it is not in the active
   * group). When unauthenticated this always throws. For a boolean
   * check read `grants` directly.
   */
  assert: (grant: string | readonly string[], doc?: { groupId?: unknown }) => void;
};

/**
 * Minimal auth helper surface required by the context resolvers.
 *
 * This stays exported because `auth.ts` re-exports it for compatibility with
 * existing consumers that reference the low-level context helpers.
 */
export type AuthLike = {
  user: {
    get: (...args: never[]) => Promise<UserDoc | null>;
    [key: string]: unknown;
  };
  active: {
    get: (...args: never[]) => Promise<{ groupId: string } | null>;
    [key: string]: unknown;
  };
  member: {
    get: (...args: never[]) => Promise<{
      membership: unknown;
      roleIds: string[];
      grants: string[];
    }>;
    list: (...args: never[]) => Promise<{
      page: Array<{ groupId: string; roleIds?: string[]; grants?: string[] }>;
    }>;
    [key: string]: unknown;
  };
};

/**
 * Configuration for {@link defineAuth().ctx} context enrichment.
 *
 * The same config shape is also used by {@link defineAuth().context}.
 *
 * @typeParam TResolve - Extra fields returned from `resolve()` and merged into
 *   the resulting `ctx.auth` object.
 *
 * @example
 * ```ts
 * const authContext = await auth.context(ctx, {
 *   resolve: async (_ctx, user, authState) => ({
 *     email: user.email,
 *     canWrite: authState.grants.includes("posts.write"),
 *   }),
 * });
 * ```
 */
export type AuthContextConfig<
  TResolve extends Record<string, unknown> = Record<string, never>,
  TCtx extends AuthIdentityCtx = AuthIdentityCtx,
> = {
  /**
   * Enforce grant(s) inline — equivalent to calling `ctx.auth.assert(...)`
   * at the top of every handler built with this customization. Throws
   * `ConvexError({ code: ErrorCode.MISSING_GRANTS })` when missing.
   */
  assert?: string | readonly string[];
  /**
   * Require an active group; throws `ConvexError({ code: ErrorCode.NO_ACTIVE_GROUP })`
   * when the resolved context has no `groupId`. Reuses the `active` concept.
   */
  active?: true;
  /**
   * Attach additional derived fields to the auth context after the base auth
   * context is resolved.
   *
   * This callback runs only when an authenticated user context is available.
   */
  resolve?: (ctx: TCtx, user: UserDoc, auth: AuthContext) => Promise<TResolve> | TResolve;
};

type ResolvedMembership = {
  membership: unknown;
  roleIds: string[];
  grants: string[];
};

type MembershipListItem = { groupId: string; roleIds?: string[]; grants?: string[] };

type AuthContextResolverLike = {
  user: {
    get: (ctx: AuthQueryCtx, args: { id: string }) => Promise<UserDoc | null>;
  };
  member: {
    get: (
      ctx: AuthQueryCtx,
      args: { userId: string; groupId: string },
    ) => Promise<ResolvedMembership>;
    list: (
      ctx: AuthQueryCtx,
      opts: {
        where: { userId: string };
        paginationOpts: { numItems: number; cursor: string | null };
        withGrants: true;
      },
    ) => Promise<{ page: MembershipListItem[] }>;
  };
};

/**
 * Narrow the loose {@link AuthLike} compat surface to the precise
 * {@link AuthContextResolverLike} the resolver body needs.
 *
 * `AuthLike`'s methods use `(...args: never[])` parameters so any concrete
 * domain object is assignable to it; those bottom-typed parameters do not
 * statically unify with the resolver's precise `(ctx, args)` signatures, so
 * this is the single sanctioned assertion at that irreducible boundary. The
 * concrete domains object (the only real value ever passed) satisfies both.
 */
function asResolver(auth: AuthLike): AuthContextResolverLike {
  return auth as unknown as AuthContextResolverLike;
}

/** @internal */
export async function getSessionUserId(ctx: AuthIdentityCtx): Promise<string | null> {
  return await getAuthenticatedUserIdOrNull(ctx);
}

/**
 * Build the `ctx.auth.assert` grant guard from the resolved grants and
 * active group. `assert(grant)` throws when a grant is missing;
 * `assert(grant, doc)` additionally asserts the group-owned `doc` belongs
 * to the active group. Reuses `member.assert`'s `MISSING_GRANTS` code.
 *
 * @internal
 */
function makeAssert(groupId: string | null, grants: readonly string[]): AuthContext["assert"] {
  return (grant, doc) => {
    const needed = Array.isArray(grant) ? grant : [grant as string];
    const missing = needed.filter((g) => !grants.includes(g));
    if (missing.length > 0) {
      throw new ConvexError({
        code: ErrorCode.MISSING_GRANTS,
        message: "User is missing required grants.",
      });
    }
    if (doc !== undefined) {
      const docGroupId = (doc as { groupId?: unknown }).groupId;
      if (groupId === null || String(docGroupId) !== groupId) {
        throw new ConvexError({
          code: ErrorCode.FORBIDDEN,
          message: "Record is not in the active group.",
        });
      }
    }
  };
}

/**
 * Resolve the caller's *effective* active group and its grants on the hot path.
 *
 * The user's persisted selection (`User.lastActiveGroup`, already on the doc
 * fetched in step 1) is honored first: a single `member.get` confirms it is
 * still a current membership and returns that membership's grants in one read.
 * Only when the selection is unset — or is no longer a current membership —
 * does this fall back to a bounded lookup of the user's first membership. This
 * preserves the "stored selection, else first membership" semantics of
 * `active.get` without the `member.list(100)` + `group.get` it performs.
 *
 * @internal
 */
async function resolveActiveMembership(
  auth: AuthContextResolverLike,
  ctx: AuthQueryCtx,
  userId: string,
  lastActiveGroup: string | null,
): Promise<{ groupId: string | null; roleIds: string[]; grants: string[] }> {
  if (lastActiveGroup !== null) {
    const resolved = await auth.member.get(ctx, { userId, groupId: lastActiveGroup });
    if (resolved.membership) {
      return { groupId: lastActiveGroup, roleIds: resolved.roleIds, grants: resolved.grants };
    }
  }
  const { page } = await auth.member.list(ctx, {
    where: { userId },
    paginationOpts: { numItems: 1, cursor: null },
    withGrants: true,
  });
  const first = page[0];
  if (first === undefined) {
    return { groupId: null, roleIds: [], grants: [] };
  }
  return { groupId: first.groupId, roleIds: first.roleIds ?? [], grants: first.grants ?? [] };
}

/**
 * @internal
 *
 * Resolve the caller's auth context. When `oauthScopes` is supplied (the request
 * is authenticated by a scoped OAuth access token rather than a full session),
 * the user's role grants are intersected with the token's scopes so the caller's
 * effective grants — and therefore `assert` — can never exceed the granted
 * scope. Scopes and grants share one vocabulary, so this is a set intersection.
 * A session caller passes no scopes and keeps their full role grants.
 */
export async function getAuthContextForUser(
  auth: AuthContextResolverLike,
  ctx: AuthQueryCtx,
  userId: string,
  oauthScopes?: readonly string[],
): Promise<AuthContext> {
  const user = await auth.user.get(ctx, { id: userId });
  const lastActiveGroup = typeof user?.lastActiveGroup === "string" ? user.lastActiveGroup : null;
  const resolved = await resolveActiveMembership(auth, ctx, userId, lastActiveGroup);
  const groupId = resolved.groupId;
  const role = groupId === null ? null : (resolved.roleIds[0] ?? null);
  const grants = groupId === null ? [] : resolved.grants;
  const effectiveGrants =
    oauthScopes === undefined ? grants : grants.filter((grant) => oauthScopes.includes(grant));
  return {
    userId: userId as AuthContext["userId"],
    user: user as UserDoc,
    groupId,
    role,
    grants: effectiveGrants,
    assert: makeAssert(groupId, effectiveGrants),
  };
}

/** @internal */
export async function getAuthContext(
  auth: AuthLike,
  ctx: AuthIdentityCtx & AuthQueryCtx,
): Promise<AuthContext | null> {
  const identity = await getUserIdentityOrNull(ctx);
  if (identity === null) {
    return null;
  }
  const userId = userIdFromIdentity(identity);
  const oauthScopes = oauthScopesFromIdentity(identity);
  return await getAuthContextForUser(
    asResolver(auth),
    ctx as AuthQueryCtx,
    userId,
    oauthScopes ?? undefined,
  );
}

/** @internal */
export function createUnauthenticatedAuthContext(): OptionalAuthContext {
  return {
    userId: null,
    user: null,
    groupId: null,
    role: null,
    grants: [],
    assert: makeAssert(null, []),
  };
}
