import { query } from "./_generated/server";
import { getUserId } from "@convex-dev/auth/server";

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    return userId !== null ? ctx.db.get(userId) : null;
  },
});
