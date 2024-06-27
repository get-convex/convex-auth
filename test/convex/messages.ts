import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { auth } from "./auth";

export const list = query({
  args: {},
  handler: async (ctx) => {
    // Grab the most recent messages.
    const messages = await ctx.db.query("messages").order("desc").take(100);
    // Reverse the list so that it's in a chronological order.
    return Promise.all(
      messages.reverse().map(async (message) => {
        const { name, email, phone } = (await ctx.db.get(message.userId))!;
        return { ...message, author: name ?? email ?? phone ?? "Anonymous" };
      }),
    );
  },
});

export const send = mutation({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    const userId = await auth.getUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    // Send a new message.
    await ctx.db.insert("messages", { body, userId });
  },
});
