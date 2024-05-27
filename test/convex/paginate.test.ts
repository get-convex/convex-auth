import { test as baseTest, expect } from "vitest";
import schema from "./schema";
import { convexTest, runCtx } from "./setup.testing";
import { MutationCtx } from "./types";

// To test typechecking, replace MutationCtx with QueryCtx
const test = baseTest.extend<{ ctx: MutationCtx }>({
  // eslint-disable-next-line no-empty-pattern
  ctx: async ({}, use) => {
    const t = convexTest(schema);
    await t.run(async (baseCtx) => {
      const ctx = await runCtx(baseCtx);
      await use(ctx);
    });
  },
});

test("paginate with map", async ({ ctx }) => {
  const user1 = await ctx
    .table("users")
    .insert({ name: "Stark", email: "tony@stark.com", height: 3 })
    .get();
  await ctx
    .table("messages")
    .insert({ text: "Hello world", userId: user1._id })
    .get();
  await ctx.table("profiles").insert({ bio: "Hello world", userId: user1._id });

  const messages = await ctx
    .table("messages")
    .paginate({ cursor: null, numItems: 1 })
    .map(async (message) => ({
      text: message.text,
      author: (await message.edge("user")).name,
    }));
  expect(messages.page).toHaveLength(1);
  expect(messages.page[0].text).toEqual("Hello world");
  expect(messages.page[0].author).toEqual("Stark");
});
