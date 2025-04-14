import { createAccount } from "../../dist/server/index";
import { internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";

const TEST_USER_EMAIL = "secret@secret.com";

export const getTestUser = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", TEST_USER_EMAIL))
      .unique();
  },
});

export const init = internalAction({
  args: {},
  handler: async (ctx) => {
    const existingUser = await ctx.runQuery(internal.tests.getTestUser);
    if (existingUser !== null) {
      console.info("Test user already exists, skipping creation");
      return;
    }
    await createAccount(ctx, {
      provider: "secret",
      account: { id: TEST_USER_EMAIL },
      profile: { email: TEST_USER_EMAIL },
    });
    console.info("Test user created");
  },
});
