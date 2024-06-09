import { authTables } from "@xixixao/convex-auth/server";
import { internalMutation } from "./_generated/server";

// Deletes all auth-related data.
// Just for demoing purposes, feel free to delete.
export const reset = internalMutation({
  handler: async (ctx) => {
    for (const table of Object.keys(authTables)) {
      for (const { _id } of await ctx.db.query(table as any).collect()) {
        await ctx.db.delete(_id);
      }
    }
  },
});
