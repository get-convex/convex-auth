import { GenericId } from "convex/values";
import { ConvexAuthConfig } from "../index.js";
import { AuthTableName, MutationCtx } from "./types.js";

/**
 * All auth table names that can have triggers.
 */
const AUTH_TABLES: AuthTableName[] = [
  "users",
  "authAccounts",
  "authSessions",
  "authRefreshTokens",
  "authVerificationCodes",
  "authVerifiers",
  "authRateLimits",
];

/**
 * Creates a wrapped mutation context that automatically fires triggers
 * for auth table operations. The wrapped db has the exact same interface
 * as the original, so the returned ctx is fully compatible with MutationCtx.
 *
 * Usage:
 * ```ts
 * function myImpl(originalCtx: MutationCtx, config: ConvexAuthConfig) {
 *   const ctx = createTriggeredCtx(originalCtx, config);
 *   // Now all ctx.db operations will fire triggers for auth tables
 *   await ctx.db.delete(session._id); // automatically fires onDelete if configured
 * }
 * ```
 */
export function createTriggeredCtx(
  ctx: MutationCtx,
  config: ConvexAuthConfig,
): MutationCtx {
  const triggers = config.triggers;
  if (!triggers) {
    // No triggers configured, just return the original ctx
    return ctx;
  }

  const rawDb = ctx.db;

  /**
   * Detect which auth table an ID belongs to, if any.
   */
  function detectAuthTable(id: GenericId<any>): AuthTableName | null {
    for (const table of AUTH_TABLES) {
      if (rawDb.normalizeId(table, id) !== null) {
        return table;
      }
    }
    return null;
  }

  const triggeredDb: MutationCtx["db"] = {
    /**
     * Insert a document, firing onCreate trigger if it's an auth table.
     * Only reads doc if trigger needs it (fn.length >= 2).
     */
    insert: async (table: any, data: any) => {
      const id = await rawDb.insert(table, data);
      const trigger = (triggers as any)[table]?.onCreate;
      if (trigger) {
        if (trigger.length >= 2) {
          const doc = await rawDb.get(id);
          if (doc) {
            await trigger(ctx, doc);
          }
        } else {
          await trigger(ctx);
        }
      }
      return id;
    },

    /**
     * Patch a document, firing onUpdate trigger if it's an auth table.
     * Reads based on fn.length: 2=newDoc only, 3+=both old and new.
     */
    patch: async (id: any, updates: any) => {
      const table = detectAuthTable(id);
      const trigger = table ? (triggers as any)[table]?.onUpdate : null;
      if (!trigger) {
        await rawDb.patch(id, updates);
        return;
      }
      const needsOldDoc = trigger.length >= 3;
      const needsNewDoc = trigger.length >= 2;
      const oldDoc = needsOldDoc ? await rawDb.get(id) : null;
      await rawDb.patch(id, updates);
      if (needsNewDoc) {
        const newDoc = await rawDb.get(id);
        if (newDoc) {
          await trigger(ctx, newDoc, oldDoc);
        }
      } else {
        await trigger(ctx);
      }
    },

    /**
     * Replace a document, firing onUpdate trigger if it's an auth table.
     * Reads based on fn.length: 2=newDoc only, 3+=both old and new.
     */
    replace: async (id: any, replacementData: any) => {
      const table = detectAuthTable(id);
      const trigger = table ? (triggers as any)[table]?.onUpdate : null;
      if (!trigger) {
        await rawDb.replace(id, replacementData);
        return;
      }
      const needsOldDoc = trigger.length >= 3;
      const needsNewDoc = trigger.length >= 2;
      const oldDoc = needsOldDoc ? await rawDb.get(id) : null;
      await rawDb.replace(id, replacementData);
      if (needsNewDoc) {
        const newDoc = await rawDb.get(id);
        if (newDoc) {
          await trigger(ctx, newDoc, oldDoc);
        }
      } else {
        await trigger(ctx);
      }
    },

    /**
     * Delete a document, firing onDelete trigger if it's an auth table.
     * Reads doc before delete if fn.length >= 3, otherwise just passes ID.
     */
    delete: async (id: any) => {
      const table = detectAuthTable(id);
      const trigger = table ? (triggers as any)[table]?.onDelete : null;
      if (trigger) {
        const needsDoc = trigger.length >= 3;
        const doc = needsDoc ? await rawDb.get(id) : null;
        await trigger(ctx, id, doc);
      }
      await rawDb.delete(id);
    },

    // Pass-through methods that don't need triggers
    get: rawDb.get.bind(rawDb),
    query: rawDb.query.bind(rawDb),
    normalizeId: rawDb.normalizeId.bind(rawDb),
    system: rawDb.system,
  };

  return {
    ...ctx,
    db: triggeredDb,
  };
}
