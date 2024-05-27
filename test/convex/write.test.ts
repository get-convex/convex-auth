import { test as baseTest, expect } from "vitest";
import schema from "./schema";
import { convexTest, runCtx } from "./setup.testing";
import { MutationCtx } from "./types";

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

test("unique field check", async ({ ctx }) => {
  const newUserId = await ctx.table("users").insert({
    name: "Gates",
    email: "bill@gates.com",
  });
  await expect(async () => {
    await ctx.table("users").insert({
      name: "Mellinda",
      email: "bill@gates.com",
    });
  }).rejects.toThrowError(
    `In table "users" cannot create a duplicate document with field "email" of value \`bill@gates.com\``,
  );
  await ctx.table("users").getX(newUserId).delete();
});

test("uniqueness check", async ({ ctx }) => {
  const newUserId = await ctx.table("users").insert({
    name: "Gates",
    email: "bill@gates.com",
  });
  const newProfileId = await ctx.table("profiles").insert({
    bio: "Hello world",
    userId: newUserId,
  });
  await expect(async () => {
    await ctx.table("profiles").insert({
      bio: "Better world",
      userId: newUserId,
    });
  }).rejects.toThrowError(
    `In table "profiles" cannot create a duplicate 1:1 edge "user"`,
  );
  await ctx.table("profiles").getX(newProfileId).delete();
  await ctx.table("users").getX(newUserId).delete();
});

// Insert 1:1 from ref side is not possible, because the required side of
// the edge cannot be removed.
test("insert 1:1 from ref side", async ({ ctx }) => {
  async () => {
    const someProfile = await ctx.table("profiles").firstX();
    await ctx.table("users").insert({
      name: "Gates",
      email: "bill@gates.com",
      profile: someProfile._id,
    });
  };
});
test("insert 1:many from ref side", async ({ ctx }) => {
  const someUserId = await ctx.table("users").insert({
    name: "Jobs",
    email: "steve@jobs.com",
  });
  const newMessageId = await ctx.table("messages").insert({
    text: "Hello world",
    userId: someUserId,
  });
  const newUserId = await ctx.table("users").insert({
    name: "Gates",
    email: "bill@gates.com",
    messages: [newMessageId],
  });
  const updatedMessage = await ctx.table("messages").getX(newMessageId);
  expect(updatedMessage.userId).toEqual(newUserId);
  await ctx.table("users").getX(newUserId).delete();
  // Messages get deleted automatically via cascading delete:
  const deletedMessage = await ctx.table("messages").get(newMessageId);
  expect(deletedMessage).toBeNull();
});

test("insert and delete many:many", async ({ ctx }) => {
  const someUserId = await ctx.table("users").insert({
    name: "Gates",
    email: "bill@gates.com",
  });
  const newMessageId = await ctx.table("messages").insert({
    text: "Hello world",
    userId: someUserId,
  });
  const newTag = await ctx
    .table("tags")
    .insert({ name: "Blue", messages: [newMessageId] })
    .get();
  expect(await newTag.edge("messages")).toHaveLength(1);

  const messageTags = await ctx
    .table("messages")
    .getX(newMessageId)
    .edge("tags");
  expect(messageTags).toHaveLength(1);
  expect(messageTags[0].name).toEqual("Blue");

  // Test the edge deletion behavior
  expect(
    await (ctx.db as any).query("messages_to_tags").collect(),
  ).toHaveLength(1);
  await ctx.table("messages").getX(newMessageId).delete();
  expect(
    await (ctx.db as any).query("messages_to_tags").collect(),
  ).toHaveLength(0);
});

test("patch to remove many:many", async ({ ctx }) => {
  const someUserId = await ctx.table("users").insert({
    name: "Gates",
    email: "bill@gates.com",
  });
  const newMessageId = await ctx.table("messages").insert({
    text: "Hello world",
    userId: someUserId,
  });
  const newTag = await ctx
    .table("tags")
    .insert({ name: "Blue", messages: [newMessageId] })
    .get();

  expect(
    await (ctx.db as any).query("messages_to_tags").collect(),
  ).toHaveLength(1);
  expect(
    await ctx.table("tags").getX(newTag._id).edge("messages"),
  ).toHaveLength(1);
  expect(
    await ctx.table("messages").getX(newMessageId).edge("tags"),
  ).toHaveLength(1);

  await newTag.patch({
    messages: {
      remove: [newMessageId],
    },
  });

  // Test the edge deletion behavior
  expect(
    await (ctx.db as any).query("messages_to_tags").collect(),
  ).toHaveLength(0);
  expect(
    await ctx.table("tags").getX(newTag._id).edge("messages"),
  ).toHaveLength(0);
  expect(
    await ctx.table("messages").getX(newMessageId).edge("tags"),
  ).toHaveLength(0);
});

test("replace to remove many:many", async ({ ctx }) => {
  const someUserId = await ctx.table("users").insert({
    name: "Gates",
    email: "bill@gates.com",
  });
  const newMessageId = await ctx.table("messages").insert({
    text: "Hello world",
    userId: someUserId,
  });
  const newTag = await ctx
    .table("tags")
    .insert({ name: "Blue", messages: [newMessageId] })
    .get();

  await newTag.replace({
    name: "Green",
    messages: [],
  });

  // Test the edge deletion behavior
  expect(
    await (ctx.db as any).query("messages_to_tags").collect(),
  ).toHaveLength(0);
});

test("patch doesn't readd many:many edge", async ({ ctx }) => {
  const someUserId = await ctx.table("users").insert({
    name: "Gates",
    email: "bill@gates.com",
  });
  const newMessageId = await ctx.table("messages").insert({
    text: "Hello world",
    userId: someUserId,
  });
  const newTag = await ctx
    .table("tags")
    .insert({ name: "Blue", messages: [newMessageId] })
    .get();

  await newTag.patch({
    messages: {
      add: [newMessageId],
    },
  });

  // Test the edge deletion behavior
  expect(
    await (ctx.db as any).query("messages_to_tags").collect(),
  ).toHaveLength(1);
});

test("symmetric many:many", async ({ ctx }) => {
  const friendId = await ctx.table("users").insert({
    name: "Jobs",
    email: "steve@jobs.com",
  });
  const friend = await ctx.table("users").getX(friendId);
  const newUserId = await ctx.table("users").insert({
    name: "Gates",
    email: "bill@gates.com",
    friends: [friendId],
  });
  const newUser = await ctx.table("users").getX(newUserId);
  const newUserFriends = await newUser.edge("friends");
  expect(newUserFriends.length).toEqual(1);
  const someUserFriends = await friend.edge("friends");
  expect(someUserFriends.length).toEqual(1);
  expect(newUserFriends[0].name).toEqual("Jobs");

  // Test correct deletion
  const updatedFriends = await newUser
    .replace({ name: "Gates", email: "bill@gates.com" })
    .get()
    .edge("friends");
  expect(updatedFriends.length).toEqual(0);
  const updatedSomeUserFriends = await friend.edge("friends");
  expect(updatedSomeUserFriends.length).toEqual(0);

  await friend.delete();
  await newUser.delete();
});

// Patch 1:1 from ref side is not possible, because the required side of
// the edge cannot be removed.
test("patch 1:1 from ref side", async ({ ctx }) => {
  const someUserId = await ctx
    .table("users")
    .insert({ name: "Jobs", email: "steve@jobs.com" });
  const someProfile = await ctx
    .table("profiles")
    .insert({ bio: "Hello world", userId: someUserId });

  async () => {
    await ctx.table("users").getX(someUserId).patch({
      // @ts-expect-error This is not allowed
      profile: someProfile._id,
    });
  };
});

// Patch 1:many from ref side is not possible, because the required side of
// the edge cannot be removed.
test("patch 1:many from ref side", async ({ ctx }) => {
  const someUserId = await ctx
    .table("users")
    .insert({ name: "Jobs", email: "steve@jobs.com" });
  const message = await ctx
    .table("messages")
    .insert({ text: "Hello world", userId: someUserId });

  async () => {
    await ctx.table("users").getX(someUserId).patch({
      // @ts-expect-error This is not allowed
      message: message._id,
    });
  };
});

// Replace 1:1 from ref side is not possible, because the required side of
// the edge cannot be removed.
test("replace 1:1 from ref side", async ({ ctx }) => {
  const someUserId = await ctx
    .table("users")
    .insert({ name: "Jobs", email: "steve@jobs.com" });
  const someProfile = await ctx
    .table("profiles")
    .insert({ bio: "Hello world", userId: someUserId });

  async () => {
    await ctx.table("users").getX(someUserId).replace({
      name: "foo",
      email: "bar",
      // @ts-expect-error This is not allowed
      profile: someProfile._id,
    });
  };
});

// Replace 1:many from ref side is not possible, because the required side of
// the edge cannot be removed.
test("replace 1:many from ref side", async ({ ctx }) => {
  const someUserId = await ctx
    .table("users")
    .insert({ name: "Jobs", email: "steve@jobs.com" });
  const message = await ctx
    .table("messages")
    .insert({ text: "Hello world", userId: someUserId });

  async () => {
    await ctx.table("users").getX(someUserId).replace({
      name: "foo",
      email: "bar",
      // @ts-expect-error This is not allowed
      message: message._id,
    });
  };
});

test("simple patch", async ({ ctx }) => {
  const newUser = await ctx
    .table("users")
    .insert({ name: "Gates", email: "bill@gates.com" })
    .get();
  const updatedUser = await newUser.patch({ name: "Bill" }).get();
  expect(updatedUser.name).toEqual("Bill");
  expect(updatedUser.email).toEqual("bill@gates.com");
});

test("many:many edges configuration", async ({ ctx }) => {
  await ctx.table("posts").insert({ text: "My great post" } as any);
  const [postId1, postId2] = await ctx.table("posts").insertMany([
    { text: "My great video", type: "video", numLikes: 4 },
    { text: "My awesome video", type: "video", numLikes: 0 },
  ]);
  const [attachmentId1, attachmentId2] = await ctx
    .table("attachments")
    .insertMany([
      {
        originId: postId1,
        copyId: postId2,
        shareId: postId1,
        in: [postId1, postId2],
      },
      { originId: postId2, copyId: postId1, shareId: postId1 },
    ]);
  await ctx
    .table("attachments")
    .getX(attachmentId1)
    .patch({
      siblings: { add: [attachmentId2] },
      replacing: { add: [attachmentId2] },
    });
  const attachment1 = ctx.table("attachments").getX(attachmentId1);
  expect((await attachment1.edge("origin"))._id).toEqual(postId1);
  expect((await attachment1.edge("copy"))._id).toEqual(postId2);
  expect((await attachment1.edge("share"))._id).toEqual(postId1);
  expect((await attachment1.edge("in")).map((ent) => ent._id)).toEqual([
    postId1,
    postId2,
  ]);
  expect((await attachment1.edge("siblings")).map((ent) => ent._id)).toEqual([
    attachmentId2,
  ]);
  expect((await attachment1.edge("replacing")).map((ent) => ent._id)).toEqual([
    attachmentId2,
  ]);
});

test("write after write", async ({ ctx }) => {
  const user = await ctx
    .table("users")
    .insert({
      name: "Gates",
      email: "bill@gates.com",
    })
    .get();
  const updatedUser = await user.patch({ name: "Bill" }).get();
  expect(updatedUser.name).toEqual("Bill");
});

test("1:1 edge write from required end", async ({ ctx }) => {
  const userId = await ctx.table("users").insert({
    name: "Gates",
    email: "bill@gates.com",
  });
  const profileId = await ctx
    .table("profiles")
    .insert({ bio: "Hello world", userId });
  await ctx
    .table("profiles")
    .getX(profileId)
    .edge("user")
    .patch({ name: "Bill" });
  expect((await ctx.table("users").getX(userId)).name).toEqual("Bill");
});

test("1:1 edge write from optional end", async ({ ctx }) => {
  const userId = await ctx.table("users").insert({
    name: "Gates",
    email: "bill@gates.com",
  });
  const profileId = await ctx
    .table("profiles")
    .insert({ bio: "Hello world", userId });
  await ctx
    .table("users")
    .getX(userId)
    .edgeX("profile")
    .patch({ bio: "Big boss" });
  expect((await ctx.table("profiles").getX(profileId)).bio).toEqual("Big boss");
});

test("1:1 edge write loaded", async ({ ctx }) => {
  const userId = await ctx.table("users").insert({
    name: "Gates",
    email: "bill@gates.com",
  });
  const profile = await ctx
    .table("profiles")
    .insert({ bio: "Hello world", userId })
    .get();
  await profile.edge("user").patch({ name: "Bill" });
  expect((await ctx.table("users").getX(userId)).name).toEqual("Bill");
});

test("1:many edge write", async ({ ctx }) => {
  const userId = await ctx.table("users").insert({
    name: "Gates",
    email: "bill@gates.com",
  });
  const messageId = await ctx
    .table("messages")
    .insert({ text: "Hello world", userId });

  await ctx
    .table("messages")
    .getX(messageId)
    .edge("user")
    .patch({ name: "Bill" });
  expect((await ctx.table("users").getX(userId)).name).toEqual("Bill");
});

test("1:many edge write loaded", async ({ ctx }) => {
  const userId = await ctx.table("users").insert({
    name: "Gates",
    email: "bill@gates.com",
  });
  const message = await ctx
    .table("messages")
    .insert({ text: "Hello world", userId })
    .get();

  await message.edge("user").patch({ name: "Bill" });
  expect((await ctx.table("users").getX(userId)).name).toEqual("Bill");
});

test("edge write in pagination", async ({ ctx }) => {
  const user = await ctx
    .table("users")
    .insert({
      name: "Gates",
      email: "bill@gates.com",
    })
    .get();
  await ctx.table("messages").insert({ text: "Hello world", userId: user._id });

  await user
    .edge("messages")
    .paginate({ cursor: null, numItems: 5 })
    .map(async (message) => {
      await message.edge("user").patch({ name: "Bill" });
    });
  expect((await ctx.table("users").getX(user._id)).name).toEqual("Bill");
});

test("write from indexed get", async ({ ctx }) => {
  await ctx.table("users").insert({
    name: "Gates",
    email: "bill@gates.com",
    height: 3,
  });
  const user = (await ctx.table("users").get("height", 3))!;
  const updatedUser = await user.patch({ height: 4 }).get();

  expect(updatedUser.height).toEqual(4);
});

test("write after many:many edge traversal", async ({ ctx }) => {
  const user = await ctx
    .table("users")
    .insert({
      name: "Gates",
      email: "bill@gates.com",
    })
    .get();
  const newMessageId = await ctx.table("messages").insert({
    text: "Hello world",
    userId: user._id,
  });
  await ctx.table("tags").insert({ name: "Blue", messages: [newMessageId] });

  const tags = await user.edge("messages").first().edge("tags");
  const updatedTag = await tags?.[0].patch({ name: "Green" }).get();

  expect(updatedTag!.name).toEqual("Green");
});

test("cascading deletes", async ({ ctx }) => {
  const userId = await ctx
    .table("users")
    .insert({ name: "Jobs", email: "steve@jobs.com" });
  const messageId = await ctx
    .table("messages")
    .insert({ text: "Hello world", userId });
  const messageDetailId = await ctx
    .table("messageDetails")
    .insert({ value: "Some detail", messageId });

  await ctx.table("users").getX(userId).delete();

  const deletedMessage = await ctx.table("messages").get(messageId);
  expect(deletedMessage).toBeNull();
  const deletedMessageDetail = await ctx
    .table("messageDetails")
    .get(messageDetailId);
  expect(deletedMessageDetail).toBeNull();
});
