import { Auth } from "convex/server";
import { ConvexError, GenericId } from "convex/values";

import { ErrorCode } from "../../shared/codes";
import type { ComponentCtx, ComponentReadCtx } from "../component/context";
import { configDefaults } from "../config";
import { getSessionUserId } from "../context";
import { cached, ctxCacheHas, invalidateCtxCache } from "../cache/context";
import type { Doc, UserOrderBy, UserWhere } from "../types";

type ComponentAuthReadCtx = ComponentReadCtx & { auth: Auth };
type UserDocLike = Doc<"User"> | null;

/** Convex-native `PaginationResult<T>` shape returned by the `*List` component queries. */
type Paginated<T> = {
  page: T[];
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string | null;
  pageStatus?: "SplitRecommended" | "SplitRequired" | null;
};

export type UserDeps = {
  config: ReturnType<typeof configDefaults>;
};

export function createUserDomain(deps: UserDeps) {
  const { config } = deps;

  function userGet(ctx: ComponentReadCtx, opts: { id: string }): Promise<UserDocLike>;
  function userGet(
    ctx: ComponentReadCtx,
    opts: { ids: readonly string[] },
  ): Promise<Array<UserDocLike>>;
  async function userGet(
    ctx: ComponentReadCtx,
    opts: { id: string } | { ids: readonly string[] },
  ): Promise<UserDocLike | Array<UserDocLike>> {
    if ("id" in opts) {
      return (await cached(ctx, `user:${opts.id}`, () =>
        ctx.runQuery(config.component.user.get, {
          id: opts.id,
        }),
      )) as UserDocLike;
    }
    const userIds = opts.ids;
    if (userIds.length === 0) return [];
    const unique = Array.from(new Set(userIds));
    const toFetch: string[] = [];
    for (const id of unique) {
      if (!ctxCacheHas(ctx, `user:${id}`)) {
        toFetch.push(id);
      }
    }
    if (toFetch.length > 0) {
      const docs = (await ctx.runQuery(config.component.user.get, {
        ids: toFetch,
      })) as Array<UserDocLike>;
      for (let i = 0; i < toFetch.length; i += 1) {
        const id = toFetch[i]!;
        const value = docs[i] ?? null;
        void cached(ctx, `user:${id}`, () => Promise.resolve(value));
      }
    }
    return (await Promise.all(
      userIds.map((id) =>
        cached(ctx, `user:${id}`, () => ctx.runQuery(config.component.user.get, { id })),
      ),
    )) as Array<UserDocLike>;
  }

  async function emailPrimary(
    ctx: ComponentAuthReadCtx,
    opts?: { userId?: string },
  ): Promise<Doc<"UserEmail"> | null>;
  async function emailPrimary(
    ctx: ComponentCtx & { auth: Auth },
    email: string,
    opts?: { userId?: string },
  ): Promise<{ email: string }>;
  async function emailPrimary(
    ctx: ComponentAuthReadCtx | (ComponentCtx & { auth: Auth }),
    emailOrOpts?: string | { userId?: string },
    maybeOpts?: { userId?: string },
  ): Promise<(Doc<"UserEmail"> | null) | { email: string }> {
    const setting = typeof emailOrOpts === "string";
    const opts = (setting ? maybeOpts : emailOrOpts) as { userId?: string } | undefined;
    const userId = opts?.userId ?? (await getSessionUserId(ctx));
    if (userId === null || userId === undefined) {
      if (setting) {
        throw new ConvexError({
          code: ErrorCode.NOT_SIGNED_IN,
          message: "Authentication required.",
        });
      }
      return null;
    }
    if (setting) {
      await (ctx as ComponentCtx).runMutation(config.component.user.email.promote, {
        userId,
        email: (emailOrOpts as string).toLowerCase(),
      });
      return { email: (emailOrOpts as string).toLowerCase() };
    }
    const rows = (await ctx.runQuery(config.component.user.email.list, {
      userId,
    })) as Doc<"UserEmail">[];
    return rows.find((r) => r.isPrimary) ?? null;
  }

  const user = {
    /**
     * Fetch a user document by ID, or a batch of user documents by IDs.
     *
     * @example Single
     * ```ts
     * const user = await auth.user.get(ctx, { id: userId });
     * ```
     *
     * @example Batched
     * ```ts
     * const users = await auth.user.get(ctx, { ids: memberIds });
     * ```
     */
    get: userGet,
    /**
     * The current session's user id, or `null` when unauthenticated.
     *
     * Pairs with {@link viewer} which fetches the full document; use `id`
     * when you only need the id (no DB read for the user row).
     *
     * @example
     * ```ts
     * const userId = await auth.user.id(ctx);
     * if (userId === null) return null;
     * ```
     */
    id: async (ctx: ComponentAuthReadCtx) => {
      return (await getSessionUserId(ctx)) as GenericId<"User"> | null;
    },
    /**
     * List users with optional filtering, pagination, and ordering.
     *
     * Supports filtering by `email`, `phone`, `name`, and `isAnonymous`.
     * Results are paginated — pass `continueCursor` from a previous response
     * into the next `paginationOpts.cursor`.
     *
     * @param ctx - Convex query or mutation context.
     * @param opts.where - Filter criteria (all optional, combined with AND).
     * @param opts.paginationOpts - Convex pagination options.
     * @param opts.orderBy - Sort field: `"_creationTime"` (default), `"email"`, etc.
     * @param opts.order - Sort direction: `"asc"` or `"desc"` (default `"desc"`).
     * @returns Convex `PaginationResult` — `{ page, isDone, continueCursor }`.
     *
     * @example
     * ```ts
     * const { page, continueCursor } = await auth.user.list(ctx, {
     *   where: { email: "alice@example.com" },
     *   paginationOpts: { numItems: 10, cursor: null },
     * });
     * ```
     */
    list: async (
      ctx: ComponentReadCtx,
      opts: {
        where?: UserWhere;
        paginationOpts: { numItems: number; cursor: string | null };
        orderBy?: UserOrderBy;
        order?: "asc" | "desc";
      },
    ) => {
      return (await ctx.runQuery(config.component.user.list, {
        where: opts.where,
        paginationOpts: opts.paginationOpts,
        orderBy: opts.orderBy,
        order: opts.order,
      })) as Paginated<Doc<"User">>;
    },
    /**
     * Convenience method: resolve the current session user and fetch their
     * full document in one call. Returns `null` if unauthenticated.
     *
     * @param ctx - Convex query or mutation context with `auth` for session lookup.
     * @returns The authenticated user's document, or `null` if unauthenticated.
     *
     * @example
     * ```ts
     * const viewer = await auth.user.viewer(ctx);
     * if (!viewer) throw new Error("Not signed in");
     * console.log(viewer.name, viewer.email);
     * ```
     */
    viewer: async (ctx: ComponentAuthReadCtx): Promise<UserDocLike> => {
      const userId = await getSessionUserId(ctx);
      if (userId === null) return null;
      return await userGet(ctx, { id: userId });
    },
    /**
     * Provider-agnostic management of the emails a user owns. Singular
     * `email` namespace (consistent with `auth.member`);
     * the collection is exposed via `.list`.
     *
     * - `list(ctx)` — every `UserEmail` the user owns (provenance incl.).
     * - `create(ctx, { email })` — record an **unverified** address. Does not
     *   verify (verification stays proof-driven via sign-in flows) and
     *   does not become primary.
     * - `remove(ctx, { email })` — delete an address. Throws if it is the
     *   primary, the only verified email, or a connection-managed row.
     * - `promote(ctx, { email })` — promote a **verified** address to primary
     *   (syncs the denormalized `User.email`).
     * - `primary.get(ctx)` — read the current primary `UserEmail | null`.
     *
     * `userId` defaults to the current session user everywhere.
     */
    email: {
      list: async (
        ctx: ComponentAuthReadCtx,
        opts?: { userId?: string },
      ): Promise<Doc<"UserEmail">[]> => {
        const userId = opts?.userId ?? (await getSessionUserId(ctx));
        if (userId === null || userId === undefined) return [];
        return (await ctx.runQuery(config.component.user.email.list, {
          userId,
        })) as Doc<"UserEmail">[];
      },
      create: async (
        ctx: ComponentCtx & { auth: Auth },
        args: { email: string; userId?: string },
      ): Promise<{ email: string }> => {
        const userId = args.userId ?? (await getSessionUserId(ctx));
        if (userId === null || userId === undefined) {
          throw new ConvexError({
            code: ErrorCode.NOT_SIGNED_IN,
            message: "Authentication required.",
          });
        }
        const addr = args.email.toLowerCase();
        await ctx.runMutation(config.component.user.email.upsert, {
          userId,
          email: addr,
          verified: false,
          isPrimary: false,
          source: "password",
        });
        return { email: addr };
      },
      remove: async (
        ctx: ComponentCtx & { auth: Auth },
        args: { email: string; userId?: string },
      ): Promise<{ email: string }> => {
        const userId = args.userId ?? (await getSessionUserId(ctx));
        if (userId === null || userId === undefined) {
          throw new ConvexError({
            code: ErrorCode.NOT_SIGNED_IN,
            message: "Authentication required.",
          });
        }
        const addr = args.email.toLowerCase();
        await ctx.runMutation(config.component.user.email.remove, {
          userId,
          email: addr,
        });
        return { email: addr };
      },
      promote: (ctx: ComponentCtx & { auth: Auth }, args: { email: string; userId?: string }) =>
        emailPrimary(
          ctx,
          args.email,
          args.userId === undefined ? undefined : { userId: args.userId },
        ),
      primary: {
        get: (ctx: ComponentAuthReadCtx, opts?: { userId?: string }) => emailPrimary(ctx, opts),
      },
    },
    /**
     * Patch a user document. Accepts any fields defined on the User schema
     * (e.g. `name`, `image`, `email`, `extend`).
     *
     * @param ctx - Convex mutation context.
     * @param opts.id - The user's document ID.
     * @param opts.patch - Fields to merge into the user document.
     * @returns `null`.
     *
     * @example
     * ```ts
     * await auth.user.update(ctx, {
     *   id: userId,
     *   patch: {
     *     name: "Alice Smith",
     *     image: "https://example.com/avatar.png",
     *   },
     * });
     * ```
     */
    update: async (ctx: ComponentCtx, opts: { id: string; patch: Record<string, unknown> }) => {
      await ctx.runMutation(config.component.user.update, {
        id: opts.id,
        patch: opts.patch,
      });
      invalidateCtxCache(ctx, `user:${opts.id}`);
      return null;
    },
    /**
     * Delete a user and all associated data.
     *
     * By default (`cascade: true`) deletes the user's sessions, accounts,
     * API keys, group memberships, passkey credentials, and TOTP factors.
     * Pass `{ cascade: false }` to delete only the user document itself.
     *
     * @param ctx - Convex mutation context.
     * @param opts.id - The user's document ID.
     * @param opts.cascade - Whether to delete related records (default `true`).
     * @returns `null`.
     * @throws `INVALID_PARAMETERS` if `cascade` is `false` but the user has linked data.
     */
    remove: async (ctx: ComponentCtx, opts: { id: string; cascade?: boolean }) => {
      await ctx.runMutation(config.component.user.remove, {
        id: opts.id,
        cascade: opts.cascade !== false,
      });
      invalidateCtxCache(ctx);
      return null;
    },
  };

  return user;
}
