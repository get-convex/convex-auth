import { GenericActionCtx, GenericDataModel } from "convex/server";
import { GenericId } from "convex/values";

import type { ComponentReadCtx } from "../component/context";
import { configDefaults } from "../config";
import { cached } from "../cache/context";
import { getAuthSessionId } from "../session/lifecycle";
import type { Doc } from "../types";

type ComponentAuthReadCtx = ComponentReadCtx & { auth: import("convex/server").Auth };

export type SessionDeps = {
  config: ReturnType<typeof configDefaults>;
  callInvalidateSessions: <DataModel extends GenericDataModel>(
    ctx: GenericActionCtx<DataModel>,
    args: { userId: GenericId<"User">; except?: GenericId<"Session">[] },
  ) => Promise<void>;
};

export function createSessionDomain(deps: SessionDeps) {
  const { config, callInvalidateSessions } = deps;

  return {
    /**
     * Revoke (sign out) all sessions for a given user.
     *
     * Marks every session belonging to `userId` as invalid so that
     * subsequent requests using those session JWTs will fail authentication.
     * Optionally, one or more sessions can be excluded — this is useful
     * when you want to sign out all *other* devices while keeping the
     * current session alive.
     *
     * This method delegates to the component's internal session
     * invalidation RPC.
     *
     * @param ctx - Convex action context.
     * @param args.userId - The user whose sessions should be revoked.
     * @param args.except - Optional array of session IDs to keep valid.
     * @returns `{ userId, except }` confirming the operation.
     *
     * @example Sign out everywhere except the current session
     * ```ts
     * const identity = await ctx.auth.getUserIdentity();
     * const sessionId = identity?.sid;
     * await auth.session.revoke(ctx, {
     *   userId,
     *   except: sessionId ? [sessionId] : [],
     * });
     * ```
     */
    revoke: async <DataModel extends GenericDataModel>(
      ctx: GenericActionCtx<DataModel>,
      args: { userId: GenericId<"User">; except?: GenericId<"Session">[] },
    ) => {
      await callInvalidateSessions(ctx, args);
      return {
        userId: args.userId,
        except: args.except ?? [],
      };
    },
    /**
     * Read a session document by ID.
     *
     * Returns the full session document from the component database, or
     * `null` if no session with the given ID exists. Useful for inspecting
     * session metadata such as creation time or associated device info.
     *
     * @param ctx - Convex query or mutation context.
     * @param opts.id - The session's document ID.
     * @returns The session document, or `null` if not found.
     *
     * @example
     * ```ts
     * const session = await auth.session.get(ctx, { id: sessionId });
     * if (!session) throw new Error("Session not found");
     * ```
     */
    get: async (ctx: ComponentReadCtx, opts: { id: string }): Promise<Doc<"Session"> | null> => {
      return (await cached(ctx, `session:${opts.id}`, () =>
        ctx.runQuery(config.component.session.get, {
          id: opts.id,
        }),
      )) as Doc<"Session"> | null;
    },
    /**
     * The current session's id, or `null` when unauthenticated.
     *
     * Pairs with `auth.user.id(ctx)`; resolves the session id from the
     * incoming JWT without a DB read.
     *
     * @example
     * ```ts
     * const sessionId = await auth.session.id(ctx);
     * if (sessionId === null) return null;
     * ```
     */
    id: async (ctx: ComponentAuthReadCtx) => {
      return (await getAuthSessionId(ctx)) as GenericId<"Session"> | null;
    },
    /**
     * List all sessions belonging to a user.
     *
     * Returns every session document associated with the given `userId`,
     * including both active and expired sessions. This is useful for
     * building "active sessions" UIs or auditing sign-in history.
     *
     * @param ctx - Convex query or mutation context.
     * @param opts.userId - The user whose sessions to list.
     * @returns An array of session documents.
     *
     * @example
     * ```ts
     * const sessions = await auth.session.list(ctx, { userId });
     * console.log(`User has ${sessions.length} sessions`);
     * ```
     */
    list: async (ctx: ComponentReadCtx, opts: { userId: string }): Promise<Doc<"Session">[]> => {
      return (await ctx.runQuery(config.component.session.list, {
        userId: opts.userId,
      })) as Doc<"Session">[];
    },
  };
}
