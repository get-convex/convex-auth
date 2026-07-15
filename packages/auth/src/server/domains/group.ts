import type { ComponentCtx, ComponentReadCtx } from "../component/context";
import { configDefaults } from "../config";
import { cached, ctxCacheHas, invalidateCtxCache } from "../cache/context";
import type { Doc } from "../types";

type GroupDocLike = Doc<"Group"> | null;

/** Convex-native `PaginationResult<T>` shape returned by the `*List` component queries. */
type Paginated<T> = {
  page: T[];
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string | null;
  pageStatus?: "SplitRecommended" | "SplitRequired" | null;
};

type GroupTree = {
  current: Doc<"Group">;
  parent: Doc<"Group"> | null;
  children: Array<Doc<"Group">>;
  ancestors: Array<Doc<"Group">>;
};

export type GroupDeps = {
  config: ReturnType<typeof configDefaults>;
};

export function createGroupDomain(deps: GroupDeps) {
  const { config } = deps;

  function groupGet(ctx: ComponentReadCtx, opts: { id: string }): Promise<GroupDocLike>;
  function groupGet(
    ctx: ComponentReadCtx,
    opts: { ids: readonly string[] },
  ): Promise<Array<GroupDocLike>>;
  async function groupGet(
    ctx: ComponentReadCtx,
    opts: { id: string } | { ids: readonly string[] },
  ): Promise<GroupDocLike | Array<GroupDocLike>> {
    if ("id" in opts) {
      return (await cached(ctx, `group:${opts.id}`, () =>
        ctx.runQuery(config.component.group.get, {
          id: opts.id,
        }),
      )) as GroupDocLike;
    }
    const groupIds = opts.ids;
    if (groupIds.length === 0) return [];
    const unique = Array.from(new Set(groupIds));
    const toFetch: string[] = [];
    for (const id of unique) {
      if (!ctxCacheHas(ctx, `group:${id}`)) {
        toFetch.push(id);
      }
    }
    if (toFetch.length > 0) {
      const docs = (await ctx.runQuery(config.component.group.get, {
        ids: toFetch,
      })) as Array<GroupDocLike>;
      for (let i = 0; i < toFetch.length; i += 1) {
        const id = toFetch[i]!;
        const value = docs[i] ?? null;
        void cached(ctx, `group:${id}`, () => Promise.resolve(value));
      }
    }
    return (await Promise.all(
      groupIds.map((id) =>
        cached(ctx, `group:${id}`, () => ctx.runQuery(config.component.group.get, { id: id })),
      ),
    )) as Array<GroupDocLike>;
  }

  function groupGetEx(ctx: ComponentReadCtx, opts: { id: string }): Promise<GroupDocLike>;
  function groupGetEx(
    ctx: ComponentReadCtx,
    opts: { ids: readonly string[] },
  ): Promise<Array<GroupDocLike>>;
  function groupGetEx(ctx: ComponentReadCtx, selector: { slug: string }): Promise<GroupDocLike>;
  function groupGetEx(
    ctx: ComponentReadCtx,
    opts: { id: string; tree: true },
  ): Promise<GroupTree | null>;
  async function groupGetEx(
    ctx: ComponentReadCtx,
    opts: { id: string; tree?: true } | { ids: readonly string[] } | { slug: string },
  ): Promise<GroupDocLike | Array<GroupDocLike> | GroupTree | null> {
    if ("slug" in opts) {
      const { page } = await group.list(ctx, {
        where: { slug: opts.slug },
        paginationOpts: { numItems: 1, cursor: null },
      });
      return page[0] ?? null;
    }
    if ("id" in opts && opts.tree === true) {
      const current = await groupGet(ctx, { id: opts.id });
      if (current === null) return null;
      const parentId = typeof current.parentGroupId === "string" ? current.parentGroupId : null;
      const [parent, childrenPage] = await Promise.all([
        parentId !== null ? groupGet(ctx, { id: parentId }) : Promise.resolve(null),
        group.list(ctx, {
          where: { parentGroupId: opts.id },
          paginationOpts: { numItems: 100, cursor: null },
        }),
      ]);
      const ancestors: Array<Doc<"Group">> = [];
      let walk = parentId;
      const seen = new Set<string>([opts.id]);
      while (walk !== null && !seen.has(walk)) {
        seen.add(walk);
        const ancestor = await groupGet(ctx, { id: walk });
        if (ancestor === null) break;
        ancestors.push(ancestor);
        walk = typeof ancestor.parentGroupId === "string" ? ancestor.parentGroupId : null;
      }
      return {
        current,
        parent,
        children: childrenPage.page,
        ancestors,
      };
    }
    if ("ids" in opts) {
      return groupGet(ctx, opts);
    }
    return groupGet(ctx, { id: opts.id });
  }

  const group = {
    /**
     * Create a new group (organization, workspace, team, etc.).
     *
     * Groups are hierarchical — set `parentGroupId` to nest under an existing
     * group, or omit it to create a root-level group. Two denormalized fields
     * are maintained automatically:
     *
     * - `rootGroupId` — the root ancestor (self-referencing for root groups).
     * - `isRoot` — `true` when the group has no parent.
     *
     * @param ctx - Convex mutation context.
     * @param opts.data.name - Display name for the group.
     * @param opts.data.slug - URL-safe slug (optional).
     * @param opts.data.type - App-defined type string (e.g. `"workspace"`, `"team"`).
     * @param opts.data.parentGroupId - Nest under this group. Omit for a root group.
     * @param opts.data.extend - Arbitrary app-specific metadata.
     * @returns The created group ID.
     *
     * @example Root group
     * ```ts
     * const groupId = await auth.group.create(ctx, {
     *   data: { name: "Acme Corp", type: "workspace" },
     * });
     * ```
     *
     * @example Nested team
     * ```ts
     * const groupId = await auth.group.create(ctx, {
     *   data: { name: "Engineering", parentGroupId: orgId, type: "team" },
     * });
     * ```
     */
    create: async (
      ctx: ComponentCtx,
      opts: {
        data: {
          name: string;
          slug?: string;
          type?: string;
          parentGroupId?: string;
          extend?: Record<string, unknown>;
        };
      },
    ): Promise<string> => {
      return (await ctx.runMutation(config.component.group.create, opts.data)) as string;
    },
    /**
     * Fetch a group document by ID, or a batch of group documents by IDs.
     * See {@link userGet} for the overload pattern.
     *
     * @example Single
     * ```ts
     * const group = await auth.group.get(ctx, { id: groupId });
     * ```
     *
     * @example Batched
     * ```ts
     * const groups = await auth.group.get(ctx, { ids: membershipGroupIds });
     * ```
     *
     * @example By slug
     * ```ts
     * const group = await auth.group.get(ctx, { slug: "acme" });
     * ```
     *
     * @example With hierarchy
     * ```ts
     * const { current, parent, children, ancestors } =
     *   (await auth.group.get(ctx, { id: groupId, tree: true }))!;
     * ```
     */
    get: groupGetEx,
    /**
     * List groups with optional filtering, pagination, and ordering.
     *
     * Supports filtering by `slug`, `type`, `parentGroupId`, `name`, and
     * `isRoot`. The `isRoot` and `parentGroupId` filters use dedicated
     * indexes for efficient queries.
     *
     * @param ctx - Convex query or mutation context.
     * @param opts.where - Filter criteria (all optional, combined with AND).
     * @param opts.where.isRoot - `true` to find root groups, `false` for nested.
     * @param opts.where.parentGroupId - List direct children of this group.
     * @param opts.paginationOpts - Convex pagination options.
     * @param opts.orderBy - Sort field: `"_creationTime"`, `"name"`, `"slug"`, `"type"`.
     * @param opts.order - Sort direction: `"asc"` or `"desc"`.
     * @returns Convex `PaginationResult` — `{ page, isDone, continueCursor }`.
     *
     * @example List root workspaces
     * ```ts
     * const { page } = await auth.group.list(ctx, {
     *   where: { isRoot: true },
     *   paginationOpts: { numItems: 25, cursor: null },
     *   orderBy: "name", order: "asc",
     * });
     * ```
     *
     * @example List children of a group
     * ```ts
     * const { page } = await auth.group.list(ctx, {
     *   where: { parentGroupId: orgId },
     *   paginationOpts: { numItems: 25, cursor: null },
     * });
     * ```
     */
    list: async (
      ctx: ComponentReadCtx,
      opts?: {
        where?: {
          slug?: string;
          type?: string;
          parentGroupId?: string;
          name?: string;
          isRoot?: boolean;
        };
        paginationOpts: { numItems: number; cursor: string | null };
        orderBy?: "_creationTime" | "name" | "slug" | "type";
        order?: "asc" | "desc";
      },
    ) => {
      return (await ctx.runQuery(config.component.group.list, {
        where: opts?.where,
        paginationOpts: opts?.paginationOpts ?? { numItems: 50, cursor: null },
        orderBy: opts?.orderBy,
        order: opts?.order,
      })) as Paginated<Doc<"Group">>;
    },
    /**
     * Patch a group document.
     *
     * If `parentGroupId` is changed, the group's `rootGroupId` and `isRoot`
     * fields are recomputed automatically and cascaded to all descendants.
     *
     * @param ctx - Convex mutation context.
     * @param opts.id - The group's document ID.
     * @param opts.patch - Fields to merge (e.g. `name`, `slug`, `parentGroupId`).
     * @returns `null`.
     *
     * @example
     * ```ts
     * await auth.group.update(ctx, {
     *   id: groupId,
     *   patch: {
     *     name: "Acme Corp (renamed)",
     *     slug: "acme-corp",
     *   },
     * });
     * ```
     */
    update: async (ctx: ComponentCtx, opts: { id: string; patch: Record<string, unknown> }) => {
      await ctx.runMutation(config.component.group.update, {
        id: opts.id,
        patch: opts.patch,
      });
      invalidateCtxCache(ctx, `group:${opts.id}`);
      return null;
    },
    /**
     * Remove a group and recursively cascade to all descendant groups,
     * their members, and invites.
     *
     * @param ctx - Convex mutation context.
     * @param opts.id - The group's document ID.
     * @returns `null`.
     *
     * @example
     * ```ts
     * await auth.group.remove(ctx, { id: groupId });
     * ```
     */
    remove: async (ctx: ComponentCtx, opts: { id: string }) => {
      await ctx.runMutation(config.component.group.remove, { id: opts.id });
      invalidateCtxCache(ctx, `group:${opts.id}`);
      invalidateCtxCache(ctx, "member");
      invalidateCtxCache(ctx, "member-inspect");
      return null;
    },
    /**
     * Walk up the group hierarchy from `groupId` and return all ancestor
     * groups in order from immediate parent to root. Detects cycles and
     * respects `maxDepth` (default 32).
     *
     * @param ctx - Convex query or mutation context.
     * @param opts.groupId - Starting group ID.
     * @param opts.maxDepth - Max levels to traverse (default 32).
     * @param opts.includeSelf - Include the starting group in the result.
     * @returns `{ ancestors, cycleDetected, maxDepthReached }`.
     *
     * @example
     * ```ts
     * const { ancestors } = await auth.group.ancestors(ctx, {
     *   groupId: teamId,
     *   includeSelf: true,
     * });
     * const rootOrg = ancestors[ancestors.length - 1];
     * ```
     */
    ancestors: async (
      ctx: ComponentReadCtx,
      opts: { groupId: string; maxDepth?: number; includeSelf?: boolean },
    ) => {
      const result = (await ctx.runQuery(config.component.group.ancestors, {
        id: opts.groupId,
        maxDepth: opts.maxDepth,
        includeSelf: opts.includeSelf,
      })) as {
        ancestors: Array<Exclude<GroupDocLike, null>>;
        cycleDetected: boolean;
        maxDepthReached: boolean;
      };
      for (const ancestor of result.ancestors) {
        const id = ancestor._id;
        void cached(ctx, `group:${id}`, () => Promise.resolve(ancestor));
      }
      return result;
    },
    groupGet,
  };

  return group;
}
