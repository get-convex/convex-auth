import { addEntRules } from "convex-ents";
import { Id } from "./_generated/dataModel";
import { entDefinitions } from "./schema";
import { QueryCtx } from "./types";

export function getEntDefinitionsWithRules(
  ctx: QueryCtx,
): typeof entDefinitions {
  return addEntRules(entDefinitions, {
    secrets: {
      read: async (secret) => {
        return ctx.viewerId === secret.ownerId;
      },
      write: async ({ operation, ent: secret, value }) => {
        if (operation === "delete") {
          return false;
        }
        if (operation === "create") {
          return ctx.viewerId === value.ownerId;
        }
        return value.ownerId === undefined || value.ownerId === secret.ownerId;
      },
    },
  });
}

export async function getViewerId(
  ctx: Omit<QueryCtx, "table" | "viewerId" | "viewer" | "viewerX">,
): Promise<Id<"users"> | null> {
  // TODO: Implement me via `ctx.skipRules.table()`
  return (await ctx.skipRules.table("users").first())?._id ?? null;
}
