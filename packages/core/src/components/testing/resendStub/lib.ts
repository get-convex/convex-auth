import { mutationGeneric as mutation } from "convex/server";
import { v } from "convex/values";

/**
 * A stub for the `lib.sendEmail` mutation of the `@convex-dev/resend`
 * component. It records the email in the `emails` table and sends
 * nothing. Tests read the table to make assertions about the sent
 * emails.
 */
export const sendEmail = mutation({
  args: {
    options: v.object({
      apiKey: v.string(),
      testMode: v.boolean(),
      initialBackoffMs: v.number(),
      retryAttempts: v.number(),
    }),
    from: v.string(),
    to: v.array(v.string()),
    subject: v.optional(v.string()),
    html: v.optional(v.string()),
    text: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const id = await ctx.db.insert("emails", {
      from: args.from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
    });
    return id;
  },
});
