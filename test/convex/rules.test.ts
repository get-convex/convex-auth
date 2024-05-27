import { expect, test } from "vitest";
import schema from "./schema";
import { convexTest, runCtx } from "./setup.testing";
import { TestConvex } from "convex-test";

// First created user is set as viewer
test("rules - query", async () => {
  const t = convexTest(schema);
  await t.run(async (baseCtx) => {
    const ctx = await runCtx(baseCtx);

    const [user1Id, user2Id] = await ctx.table("users").insertMany([
      { name: "Stark", email: "tony@stark.com", height: 3 },
      { name: "Musk", email: "elon@musk.com" },
    ]);
    await ctx.skipRules.table("secrets").insertMany([
      { value: "chicka blah", ownerId: user1Id },
      { value: "bada boom", ownerId: user2Id },
    ]);
  });

  await t.run(async (baseCtx) => {
    const ctx = await runCtx(baseCtx);
    const secrets = await ctx.table("secrets");
    expect(secrets).toHaveLength(1);
  });
});

// First created user is set as viewer
test("rules - firstX", async () => {
  const t = convexTest(schema);
  await t.run(async (baseCtx) => {
    const ctx = await runCtx(baseCtx);

    const [user1Id, user2Id] = await ctx.table("users").insertMany([
      { name: "Stark", email: "tony@stark.com", height: 3 },
      { name: "Musk", email: "elon@musk.com" },
    ]);
    await ctx.skipRules.table("secrets").insertMany([
      { value: "chicka blah", ownerId: user1Id },
      { value: "bada boom", ownerId: user2Id },
    ]);
  });

  await t.run(async (baseCtx) => {
    const ctx = await runCtx(baseCtx);
    const secret = await ctx.table("secrets").order("desc").firstX();
    expect(secret).not.toBeNull();
  });
});

// First created user is set as viewer
test("rules - edge", async () => {
  const t = convexTest(schema);
  await t.run(async (baseCtx) => {
    const ctx = await runCtx(baseCtx);

    const [user1Id, user2Id] = await ctx.table("users").insertMany([
      { name: "Stark", email: "tony@stark.com", height: 3 },
      { name: "Musk", email: "elon@musk.com" },
    ]);
    await ctx.skipRules.table("secrets").insertMany([
      { value: "chicka blah", ownerId: user1Id },
      { value: "bada boom", ownerId: user2Id },
    ]);
  });

  await t.run(async (baseCtx) => {
    const ctx = await runCtx(baseCtx);
    const [firstUser, secondUser] = await ctx.table("users").take(2);
    const viewerSecret = await firstUser.edge("secret");
    expect(viewerSecret?.value).toEqual("chicka blah");
    const otherSecret = await secondUser.edge("secret");
    expect(otherSecret).toEqual(null);
  });
});

test("write rule on insert", async () => {
  const t = convexTest(schema);
  await addViewer(t);
  await t.run(async (baseCtx) => {
    const ctx = await runCtx(baseCtx);

    const viewer = await ctx.table("users").firstX();
    const otherUserId = await ctx
      .table("users")
      .insert({ name: "Jobs", email: "steve@jobs.com" });
    // rules.ts: This works because the viewer is writing
    await ctx.table("secrets").insert({ value: "123", ownerId: viewer._id });
    await expect(async () => {
      // rules.ts: We only allow the viewer to create secrets
      await ctx.table("secrets").insert({
        value: "123",
        ownerId: otherUserId,
      });
    }).rejects.toThrowError(`Cannot insert into table "secrets":`);
  });
});

test("write rule on delete", async () => {
  const t = convexTest(schema);
  await addViewer(t);
  await t.run(async (baseCtx) => {
    const ctx = await runCtx(baseCtx);

    const viewer = await ctx.table("users").firstX();
    const secret = await ctx
      .table("secrets")
      .insert({ value: "123", ownerId: viewer._id })
      .get();
    await expect(async () => {
      // rules.ts: We don't allow anyone to delete a secret
      await secret.delete();
    }).rejects.toThrowError(`Cannot delete from table "secrets" with ID`);
  });
});

test("read rule on patch", async () => {
  const t = convexTest(schema);
  await addViewer(t);
  await t.run(async (baseCtx) => {
    const ctx = await runCtx(baseCtx);

    const otherUserId = await ctx
      .table("users")
      .insert({ name: "Jobs", email: "steve@jobs.com" });
    const secretId = await ctx.skipRules
      .table("secrets")
      .insert({ value: "123", ownerId: otherUserId });

    await expect(async () => {
      // rules.ts: Only owners can see and update their secrets
      await ctx.table("secrets").getX(secretId).patch({ value: "456" });
    }).rejects.toThrowError(`Cannot update document with ID`);
  });
});

test("write rule on patch", async () => {
  const t = convexTest(schema);
  await addViewer(t);
  await t.run(async (baseCtx) => {
    const ctx = await runCtx(baseCtx);

    const otherUserId = await ctx
      .table("users")
      .insert({ name: "Jobs", email: "steve@jobs.com" });
    const secretId = await ctx.skipRules
      .table("secrets")
      .insert({ value: "123", ownerId: ctx.viewerId! });

    await expect(async () => {
      // rules.ts: The user edge is immutable
      await ctx.table("secrets").getX(secretId).patch({ ownerId: otherUserId });
    }).rejects.toThrowError(`Cannot update document with ID`);

    // This is ok
    await ctx.table("secrets").getX(secretId).patch({ value: "456" });
  });
});

test("read rule on replace", async () => {
  const t = convexTest(schema);
  await addViewer(t);
  await t.run(async (baseCtx) => {
    const ctx = await runCtx(baseCtx);

    const otherUserId = await ctx
      .table("users")
      .insert({ name: "Jobs", email: "steve@jobs.com" });
    const secretId = await ctx.skipRules
      .table("secrets")
      .insert({ value: "123", ownerId: otherUserId });

    await expect(async () => {
      // rules.ts: Only owners can see and update their secrets
      await ctx
        .table("secrets")
        .getX(secretId)
        .replace({ ownerId: otherUserId, value: "456" });
    }).rejects.toThrowError(`Cannot update document with ID`);
  });
});

test("write rule on replace", async () => {
  const t = convexTest(schema);
  await addViewer(t);
  await t.run(async (baseCtx) => {
    const ctx = await runCtx(baseCtx);

    const otherUserId = await ctx
      .table("users")
      .insert({ name: "Jobs", email: "steve@jobs.com" });
    const secretId = await ctx.skipRules
      .table("secrets")
      .insert({ value: "123", ownerId: ctx.viewerId! });

    await expect(async () => {
      // rules.ts: The user edge is immutable
      await ctx
        .table("secrets")
        .getX(secretId)
        .replace({ ownerId: otherUserId, value: "456" });
    }).rejects.toThrowError(`Cannot update document with ID`);

    // This is ok
    await ctx
      .table("secrets")
      .getX(secretId)
      .replace({ ownerId: ctx.viewerId!, value: "456" });
  });
});

async function addViewer(t: TestConvex<typeof schema>) {
  await t.run(async (baseCtx) => {
    const ctx = await runCtx(baseCtx);
    await ctx.table("users").insert({ name: "Stark", email: "tony@stark.com" });
  });
}
