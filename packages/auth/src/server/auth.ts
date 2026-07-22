/**
 * Auth configuration helpers for Convex Auth.
 *
 * @module
 */

import type { GenericActionCtx, GenericDataModel, HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import type { GenericValidator } from "convex/values";

import { ErrorCode } from "../shared/codes";
import type { AuthApiRefs } from "../client/index";
import { createAuthContextFacade } from "./facade";
import type { McpToolDef } from "./mcp";
import type {
  AuthConfig,
  AuthContext,
  AuthContextConfig,
  AuthContextFacade,
  AuthContextFactory,
  AuthContextResolver,
  AuthLike,
  InferAuth,
  OptionalAuthContext,
  OptionalAuthContextFactory,
  OptionalAuthContextResolver,
  UserDoc,
} from "./facade";
import { Auth as AuthFactory } from "./runtime";
import { createAuthValidators } from "./validators";
import type { AuthExtendValidators, AuthValidators } from "./validators";
import type {
  AuthMemberInspectResult,
  AuthProviderConfig,
  ConvexAuthConfig,
  Doc,
  Grant,
  HasDeviceProvider,
  HasPasskeyProvider,
  HasTotpProvider,
  PermissionsConfig,
  RoleId,
} from "./types";

export type { AuthConfig, AuthContext, AuthContextConfig, InferAuth, OptionalAuthContext, UserDoc };
export type { AuthExtendValidators, AuthValidators };

/**
 * `member.get`/`member.assert` result with `roleIds`/`grants` narrowed
 * from `string[]` to the permission-typed literal unions.
 */
type MemberAccessResult<TPermissions extends PermissionsConfig | undefined> = Omit<
  AuthMemberInspectResult,
  "roleIds" | "grants"
> & {
  roleIds: RoleId<TPermissions>[];
  grants: Grant<TPermissions>[];
};

type MemberApiWithPermissions<TPermissions extends PermissionsConfig | undefined> = Omit<
  ReturnType<typeof AuthFactory>["auth"]["member"],
  "create" | "list" | "update" | "get" | "assert"
> & {
  create: (
    ctx: Parameters<ReturnType<typeof AuthFactory>["auth"]["member"]["create"]>[0],
    args: {
      data: {
        groupId: string;
        userId: string;
        roleIds?: RoleId<TPermissions>[];
        status?: string;
        extend?: Record<string, unknown>;
      };
    },
  ) => Promise<string>;
  list: <
    O extends
      | {
          where?: {
            groupId?: string;
            userId?: string;
            roleId?: RoleId<TPermissions>;
            status?: string;
          };
          paginationOpts?: { numItems: number; cursor: string | null };
          orderBy?: "_creationTime" | "status";
          order?: "asc" | "desc";
          /** Join each item's `group` document. */
          withGroup?: true;
          /** Resolve each item's `roleIds` + `grants`, capped to the caller's scope. */
          withGrants?: true;
        }
      | undefined = undefined,
  >(
    ctx: Parameters<ReturnType<typeof AuthFactory>["auth"]["member"]["list"]>[0],
    opts?: O,
  ) => Promise<{
    page: Array<
      Doc<"GroupMember"> &
        (O extends { withGroup: true } ? { group: Doc<"Group"> | null } : unknown) &
        (O extends { withGrants: true }
          ? { roleIds: RoleId<TPermissions>[]; grants: Grant<TPermissions>[] }
          : unknown)
    >;
    isDone: boolean;
    continueCursor: string;
  }>;
  update: (
    ctx: Parameters<ReturnType<typeof AuthFactory>["auth"]["member"]["update"]>[0],
    args: {
      id: string;
      patch: Record<string, unknown> & { roleIds?: RoleId<TPermissions>[] };
    },
  ) => Promise<null>;
  get: {
    (
      ctx: Parameters<ReturnType<typeof AuthFactory>["auth"]["member"]["get"]>[0],
      args: { userId: string; groupId: string; ancestry?: boolean; maxDepth?: number },
    ): Promise<MemberAccessResult<TPermissions>>;
    (
      ctx: Parameters<ReturnType<typeof AuthFactory>["auth"]["member"]["get"]>[0],
      args: { userId: string; groupIds: readonly string[] },
    ): Promise<MemberAccessResult<TPermissions>[]>;
  };
  assert: (
    ctx: Parameters<ReturnType<typeof AuthFactory>["auth"]["member"]["assert"]>[0],
    opts: {
      userId: string;
      groupId: string;
      ancestry?: boolean;
      roleIds?: RoleId<TPermissions>[];
      grants?: Grant<TPermissions>[];
      maxDepth?: number;
    },
  ) => Promise<MemberAccessResult<TPermissions>>;
};

/**
 * `request.mcp` with each tool's `scope` narrowed from `string` to the
 * permission-typed grant union — a tool may only require a declared grant, so a
 * typo or stale scope is a compile error.
 */
type RequestApiWithPermissions<TPermissions extends PermissionsConfig | undefined> = Omit<
  ReturnType<typeof AuthFactory>["auth"]["request"],
  "mcp"
> & {
  mcp: <T extends Record<string, GenericValidator>>(
    http: HttpRouter,
    tools: { [K in keyof T]: McpToolDef<T[K], Grant<TPermissions>> },
    opts?: { name?: string; version?: string },
  ) => void;
};

/**
 * The base auth API surface returned by {@link defineAuth}.
 *
 * Provides core namespaces — `signIn`, `signOut`, `user`, `session`,
 * `member`, `invite`, `group`, `key`, and `request` — that are
 * always available regardless of which providers are configured.
 * Use this type when you want to describe code that only depends on the
 * standard auth surface and should not assume group connection features exist.
 *
 * @typeParam TPermissions - The permissions config, used to narrow
 *   role IDs and grant strings on the `member` API.
 */
export type AuthApiBase<
  TPermissions extends PermissionsConfig | undefined = undefined,
  TExtend extends AuthExtendValidators = {},
> = {
  /**
   * Convex `returns:` validators for the auth read surface.
   *
   * Set these as a function's `returns:` so client-side `useQuery`
   * inference flows end-to-end without hand-rolled validators or DTO
   * mappers. The `extend` field of each document carries the shape
   * supplied via `defineAuth({ extend: { ... } })`.
   *
   * Available validators:
   * - `v.user` / `v.group` / `v.member` — single documents (extend-aware).
   * - `v.invite` — a single group invite document.
   * - `v.viewer` — `User | null`, for a current-user query.
   * - `v.connection.*` — group connection admin facade results.
   * - `v.list(item)` — wraps an item validator in Convex's
   *   `{ page, isDone, continueCursor }` pagination result shape.
   *
   * Compose these for richer reads — e.g. a current user plus their
   * memberships and groups — using the existing `auth.user.viewer`,
   * `auth.member.list`, and `auth.group.get` facade methods.
   *
   * @example
   * ```ts
   * export const viewer = authQuery({
   *   returns: auth.v.viewer,
   *   handler: (ctx) => ctx.auth.user.viewer(ctx),
   * });
   *
   * export const groups = authQuery({
   *   returns: v.union(
   *     v.object({
   *       ...auth.v.user.fields,
   *       memberships: v.array(auth.v.member),
   *       groups: v.array(auth.v.group),
   *     }),
   *     v.null(),
   *   ),
   *   handler: async (ctx) => {
   *     const me = await ctx.auth.user.viewer(ctx);
   *     if (me === null) return null;
   *     const { page: memberships } = await ctx.auth.member.list(ctx, {
   *       where: { userId: me._id },
   *       paginationOpts: { cursor: null, numItems: 25 },
   *     });
   *     const groups = await ctx.auth.group.get(ctx, {
   *       ids: memberships.map((m) => m.groupId),
   *     });
   *     return { ...me, memberships, groups };
   *   },
   * });
   * ```
   */
  v: AuthValidators<TExtend>;
  signIn: ReturnType<typeof AuthFactory>["signIn"];
  signOut: ReturnType<typeof AuthFactory>["signOut"];
  store: ReturnType<typeof AuthFactory>["store"];
  http: ReturnType<typeof AuthFactory>["http"];
  user: ReturnType<typeof AuthFactory>["auth"]["user"];
  session: ReturnType<typeof AuthFactory>["auth"]["session"];
  provider: ReturnType<typeof AuthFactory>["auth"]["provider"];
  account: ReturnType<typeof AuthFactory>["auth"]["account"];
  group: ReturnType<typeof AuthFactory>["auth"]["group"] & {
    /** Current user's active-group selection (`get` / `update` / `remove`). */
    active: ReturnType<typeof AuthFactory>["auth"]["active"];
  };
  member: MemberApiWithPermissions<TPermissions>;
  invite: ReturnType<typeof AuthFactory>["auth"]["invite"];
  key: ReturnType<typeof AuthFactory>["auth"]["key"];
  oauth: ReturnType<typeof AuthFactory>["auth"]["oauth"];
  event: ReturnType<typeof AuthFactory>["auth"]["event"];
  request: RequestApiWithPermissions<TPermissions>;
  /**
   * Build app-owned public RPCs for group Connection admin screens.
   *
   * This mirrors Convex component setup: start from the configured auth
   * handle, then mount the Connection routes/functions from that handle.
   */
  connection: PublicGroupConnectionApi;
  /**
   * Resolve the current request's auth context. Framework-agnostic — use
   * this in custom wrappers, middleware, or anywhere you need the current
   * `{ userId, user, groupId, role, grants }` object.
   *
   * This is the authorization-enrichment path. For native identity claims
   * already present on the JWT, prefer `ctx.auth.getUserIdentity()`.
   *
   * Throws a structured `ConvexError` when unauthenticated by default.
   * Use `auth.context.optional(ctx)` to get a null-shaped auth object instead.
   *
   * @param ctx - Convex query, mutation, or action context.
   * @param config - Optional auth resolution config. Supports `require`,
   *   `active`, and `resolve`.
   * @returns The current auth context.
   *
   * @example Direct usage in a handler
   * ```ts
   * const authContext = await auth.context(ctx);
   * const { userId, grants } = authContext;
   * ```
   *
   * @example Optional usage
   * ```ts
   * const authContext = await auth.context.optional(ctx);
   * if (authContext.userId === null) {
   *   return null;
   * }
   * ```
   *
   * @example With resolve
   * ```ts
   * const authContext = await auth.context(ctx, {
   *   resolve: async (_ctx, user, state) => ({
   *     email: user.email,
   *     canWrite: state.grants.includes("posts.write"),
   *   }),
   * });
   * ```
   */
  context: AuthContextResolver & { optional: OptionalAuthContextResolver };
  /**
   * Context enrichment for convex-helpers `customQuery` / `customMutation` /
   * `customAction`.
   *
   * Resolves the current user's identity, active group, membership role,
   * and grants, then attaches them to `ctx.auth`. Returns a `Customization`
   * object compatible with convex-helpers' custom function builders.
   *
   * `ctx.auth` is the current request auth context.
   * By default this throws when unauthenticated so handlers can assume
   * `ctx.auth.userId` and `ctx.auth.user` exist.
   *
   * @returns A convex-helpers `Customization` object.
   *
   * @example One-time setup in `convex/functions.ts`
   * ```ts
   * import { query, mutation, action } from "./_generated/server";
   * import { customQuery, customMutation, customAction } from "convex-helpers/server/customFunctions";
   * import { auth } from "./auth";
   *
   * export const authQuery = customQuery(query, auth.ctx());
   * export const authMutation = customMutation(mutation, auth.ctx());
   * export const authAction = customAction(action, auth.ctx());
   * ```
   *
   * @example Per-function usage
   * ```ts
   * import { authQuery } from "./functions";
   *
   * export const list = authQuery({
   *   args: { workspaceId: v.string() },
   *   handler: async (ctx, args) => {
   *     const { userId, groupId, grants } = ctx.auth;
   *     // business logic
   *   },
   * });
   * ```
   */
  ctx: AuthContextFactory & { optional: OptionalAuthContextFactory };
};

type InternalConnectionApi = ReturnType<typeof AuthFactory>["auth"]["connection"];

type PublicGroupConnectionApi = InternalConnectionApi["connection"] & {
  signIn: (
    ctx: Parameters<InternalConnectionApi["oidc"]["signIn"]>[0],
    data: {
      connectionId?: string;
      email?: string;
      domain?: string;
      redirectTo?: string;
      loginHint?: string;
    },
  ) => Promise<{
    connectionId: string;
    protocol: "oidc" | "saml";
    providerId: string;
    signInPath: string;
    callbackPath: string;
    redirectTo?: string;
  }>;
  metadata: InternalConnectionApi["saml"]["metadata"];
  domain: {
    list: InternalConnectionApi["domain"]["list"];
    validate: InternalConnectionApi["domain"]["validate"];
    status: InternalConnectionApi["domain"]["status"];
    upsert: (
      ctx: Parameters<InternalConnectionApi["connection"]["create"]>[0],
      args: {
        connectionId: string;
        domains: Array<{
          domain: string;
          isPrimary?: boolean;
        }>;
      },
    ) => Promise<{
      connectionId: string;
      domains: Array<{
        domainId: string;
        domain: string;
        isPrimary: boolean;
        verified: boolean;
        verifiedAt: number | null;
      }>;
    }>;
    verification: {
      request: (
        ctx: Parameters<InternalConnectionApi["connection"]["create"]>[0],
        args: { connectionId: string; domain: string },
      ) => Promise<{
        connectionId: string;
        domain: string;
        requestedAt: number;
        expiresAt: number;
        challenge: {
          recordType: "TXT";
          recordName: string;
          recordValue: string;
        };
      }>;
      confirm: (
        ctx: Parameters<InternalConnectionApi["connection"]["create"]>[0],
        args: { connectionId: string; domain: string },
      ) => Promise<{
        connectionId: string;
        domain: string;
        verifiedAt?: number;
        checks: Array<{ name: string; ok: boolean; message?: string }>;
      }>;
    };
  };
  oidc: Omit<InternalConnectionApi["oidc"], "signIn">;
  saml: InternalConnectionApi["saml"];
  policy: InternalConnectionApi["policy"];
  audit: {
    list: InternalConnectionApi["audit"]["list"];
  };
  webhook: {
    endpoint: InternalConnectionApi["webhook"]["endpoint"];
    delivery: {
      list: InternalConnectionApi["webhook"]["delivery"]["list"];
    };
  };
  scim: Omit<InternalConnectionApi["scim"], "getConfigByToken" | "identity">;
};

/**
 * Auth API returned by {@link defineAuth}.
 *
 * @typeParam TPermissions - The permissions config, forwarded to
 *   {@link AuthApiBase} for typed role IDs and grant strings.
 */
export type AuthApi<
  TPermissions extends PermissionsConfig | undefined = undefined,
  TExtend extends AuthExtendValidators = {},
> = AuthApiBase<TPermissions, TExtend>;

/**
 * The return type of {@link defineAuth}.
 *
 * This lets application code keep a single `defineAuth()` call while getting
 * the canonical auth namespaces, including the flat `auth.connection.*` admin
 * facade for group connections.
 *
 * @typeParam P - The tuple of provider configs passed to `defineAuth`.
 * @typeParam TPermissions - Optional permissions config for typed roles/grants.
 */
export type ConvexAuthResult<
  P extends AuthProviderConfig[],
  TPermissions extends PermissionsConfig | undefined = undefined,
  TExtend extends AuthExtendValidators = {},
> = AuthApi<TPermissions, TExtend>;

/**
 * Infer the typed `AuthApiRefs` for the client SDK from a `defineAuth` call.
 *
 * Use this as the generic parameter for `client()` on the frontend:
 *
 * ```ts
 * // convex/auth.ts
 * export const auth = defineAuth(components.auth, { providers: [...] });
 *
 * // Frontend
 * import type { auth } from "../convex/auth";
 * import type { InferClientApi } from "@robelest/convex-auth/server";
 * const c = client<InferClientApi<typeof auth>>({ convex, api: api.auth });
 * ```
 *
 * @typeParam T - A ConvexAuthResult to extract the client API from.
 */
export type InferClientApi<T> =
  T extends ConvexAuthResult<infer P>
    ? AuthApiRefs<HasPasskeyProvider<P>, HasTotpProvider<P>, HasDeviceProvider<P>>
    : AuthApiRefs;

/**
 * Define an auth API object.
 *
 * Connection admin RPCs are exposed by wrapping the `auth.connection.*`
 * facade in your own `authMutation`/`authQuery` functions (authorize with
 * `auth.member.assert`), the same pattern as every other namespace.
 *
 * @param component - The installed auth component reference from
 *   `components.auth` in your Convex app definition.
 * @param config - Auth configuration including `providers` and optional
 *   `permissions`. All fields from {@link AuthConfig} are accepted
 *   except `component` (passed as the first argument).
 * @returns A {@link ConvexAuthResult} — the full auth API surface
 *   ({@link AuthApiBase}) plus the `connection` group-admin facade.
 *
 * @example
 * ```ts
 * export const auth = defineAuth(components.auth, {
 *   providers: [password(), google()],
 *   permissions,
 * });
 * ```
 *
 * @see {@link AuthContextConfig}
 */
export function defineAuth<
  P extends AuthProviderConfig[],
  TPermissions extends PermissionsConfig | undefined = undefined,
  TExtend extends AuthExtendValidators = {},
>(
  component: ConvexAuthConfig<TExtend>["component"],
  config: Omit<AuthConfig<TExtend>, "providers" | "permissions"> & {
    providers: P;
    permissions?: TPermissions;
    /**
     * Validators for the `extend` field of each table. Drives both the
     * inferred type of `auth.v.*` (so `viewer.extend.<field>` is typed)
     * and runtime validation of consumer return shapes.
     *
     * @example
     * ```ts
     * defineAuth(components.auth, {
     *   providers: [password()],
     *   extend: { User: v.object({ stripeCustomerId: v.optional(v.string()) }) },
     * });
     * ```
     */
    extend?: TExtend;
  },
): ConvexAuthResult<P, TPermissions, TExtend> {
  const authResult = AuthFactory({
    ...config,
    component,
    providers: [...config.providers],
  } as ConvexAuthConfig);
  const {
    domain: domainApi,
    scim: scimApi,
    connection: connectionApi,
    audit: auditApi,
    webhook: webhookApi,
    oidc: oidcApi,
    saml: samlApi,
    ...restConnection
  } = authResult.auth.connection as InternalConnectionApi;

  type SetGroupConnectionDomains = PublicGroupConnectionApi["domain"]["upsert"];
  type GroupConnectionDomainInput = Array<{
    domain: string;
    isPrimary?: boolean;
  }>;
  const setGroupConnectionDomains: PublicGroupConnectionApi["domain"]["upsert"] = async (
    ctx: Parameters<SetGroupConnectionDomains>[0],
    args: Parameters<SetGroupConnectionDomains>[1],
  ) => {
    const { connectionId } = args;
    const domains: GroupConnectionDomainInput = args.domains;
    const connection = await connectionApi.get(ctx, { id: connectionId });
    if (connection === null) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: "Connection not found.",
      });
    }

    const normalized = domains.map((entry: (typeof domains)[number]) => ({
      ...entry,
      domain: entry.domain.trim().toLowerCase(),
    }));
    const deduped = new Map<string, (typeof normalized)[number]>();
    for (const entry of normalized) {
      if (entry.domain.length === 0) {
        throw new ConvexError({
          code: ErrorCode.INVALID_PARAMETERS,
          message: "Domain must not be empty.",
        });
      }
      if (deduped.has(entry.domain)) {
        throw new ConvexError({
          code: ErrorCode.INVALID_PARAMETERS,
          message: `Duplicate domain: ${entry.domain}`,
        });
      }
      deduped.set(entry.domain, entry);
    }

    const nextDomains = [...deduped.values()];
    const primaryCount = nextDomains.filter((entry) => entry.isPrimary).length;
    if (primaryCount > 1) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: "Only one primary domain may be set.",
      });
    }
    if (nextDomains.length > 0 && primaryCount === 0) {
      nextDomains[0] = { ...nextDomains[0], isPrimary: true };
    }

    const currentDomains = await domainApi.list(ctx, { connectionId });
    const currentByDomain = new Map<string, (typeof currentDomains)[number]>(
      currentDomains.map((entry: (typeof currentDomains)[number]) => [
        entry.domain.toLowerCase(),
        entry,
      ]),
    );

    for (const existing of currentDomains) {
      if (!deduped.has(existing.domain.toLowerCase())) {
        await domainApi.remove(ctx, { id: existing._id });
      }
    }

    for (const nextDomain of nextDomains) {
      const current = currentByDomain.get(nextDomain.domain);
      if (current && current.isPrimary === Boolean(nextDomain.isPrimary)) {
        continue;
      }
      if (current) {
        await domainApi.remove(ctx, { id: current._id });
      }
      const domainId = await domainApi.create(ctx, {
        connectionId: connection._id,
        groupId: connection.groupId,
        domain: nextDomain.domain,
        isPrimary: Boolean(nextDomain.isPrimary),
      });
      if (current?.verifiedAt !== undefined) {
        await (
          ctx as {
            runMutation: GenericActionCtx<GenericDataModel>["runMutation"];
          }
        ).runMutation(component.connection.domain.verify, {
          id: domainId,
          verifiedAt: current.verifiedAt,
        });
      }
    }

    const updatedDomains = await domainApi.list(ctx, { connectionId });
    return {
      connectionId,
      domains: updatedDomains.map((domain: (typeof updatedDomains)[number]) => ({
        domainId: domain._id,
        domain: domain.domain,
        isPrimary: Boolean(domain.isPrimary),
        verified: domain.verifiedAt !== undefined,
        verifiedAt: domain.verifiedAt ?? null,
      })),
    };
  };

  const publicGroupConnection: PublicGroupConnectionApi = {
    ...restConnection,
    ...connectionApi,
    signIn: oidcApi.signIn,
    metadata: samlApi.metadata,
    oidc: {
      ...oidcApi,
    },
    saml: {
      ...samlApi,
    },
    domain: {
      list: domainApi.list,
      validate: domainApi.validate,
      status: domainApi.status,
      upsert: setGroupConnectionDomains,
      verification: {
        request: domainApi.verification.request,
        confirm: domainApi.verification.confirm,
      },
    },
    policy: restConnection.policy,
    audit: {
      list: auditApi.list,
    },
    webhook: {
      endpoint: webhookApi.endpoint,
      delivery: {
        list: webhookApi.delivery.list,
      },
    },
    scim: {
      upsert: scimApi.upsert,
      get: scimApi.get,
      status: scimApi.status,
      validate: scimApi.validate,
    },
  };

  const groupApi = {
    ...authResult.auth.group,
    active: authResult.auth.active,
  };

  const api = {
    v: createAuthValidators(config.extend ?? ({} as TExtend)),
    signIn: authResult.signIn,
    signOut: authResult.signOut,
    store: authResult.store,
    http: authResult.http,
    user: authResult.auth.user,
    session: authResult.auth.session,
    provider: authResult.auth.provider,
    account: authResult.auth.account,
    group: groupApi,
    member: authResult.auth.member,
    invite: authResult.auth.invite,
    key: authResult.auth.key,
    oauth: authResult.auth.oauth,
    event: authResult.auth.event,
    request: authResult.auth.request,
    connection: publicGroupConnection,

    ...(createAuthContextFacade(authResult.auth as AuthLike) as AuthContextFacade),
  } as unknown as ConvexAuthResult<P, TPermissions, TExtend>;
  return api;
}
