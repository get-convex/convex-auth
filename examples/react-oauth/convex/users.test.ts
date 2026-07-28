import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

// `createOrUpdateUser` is a plain app mutation — no auth components or env
// stubs involved, so a bare test instance suffices.
function setup() {
  return convexTest(schema, modules);
}

/** A verified-email profile shaped like the google catalog emits. */
const googleProfile = {
  id: "google-sub-1",
  email: "ada@example.com",
  emailVerified: true,
  name: "Ada",
};

/** A verified-email profile shaped like the github catalog emits. */
const githubProfile = {
  id: "42",
  login: "ada",
  name: "Ada",
  email: "ada@example.com",
  emailVerified: true,
};

describe("createOrUpdateUser", () => {
  test("links a second provider identity to the existing user by verified email", async () => {
    const t = setup();
    const first = await t.mutation(internal.users.createOrUpdateUser, {
      provider: "google",
      providerAccountId: googleProfile.id,
      profile: googleProfile,
      userId: null,
    });
    const second = await t.mutation(internal.users.createOrUpdateUser, {
      provider: "github",
      providerAccountId: githubProfile.id,
      profile: githubProfile,
      userId: null,
    });
    expect(second).toBe(first);
    await t.run(async (ctx) => {
      const users = await ctx.db.query("users").collect();
      expect(users).toHaveLength(1);
      expect(users[0].email).toBe("ada@example.com");
    });
  });

  test("creates a separate user for a different verified email", async () => {
    const t = setup();
    const first = await t.mutation(internal.users.createOrUpdateUser, {
      provider: "google",
      providerAccountId: googleProfile.id,
      profile: googleProfile,
      userId: null,
    });
    const second = await t.mutation(internal.users.createOrUpdateUser, {
      provider: "github",
      providerAccountId: githubProfile.id,
      profile: { ...githubProfile, email: "grace@example.com" },
      userId: null,
    });
    expect(second).not.toBe(first);
    await t.run(async (ctx) => {
      const users = await ctx.db.query("users").collect();
      expect(users).toHaveLength(2);
    });
  });

  test("rejects an unverified email", async () => {
    const t = setup();
    await expect(
      t.mutation(internal.users.createOrUpdateUser, {
        provider: "github",
        providerAccountId: githubProfile.id,
        profile: { ...githubProfile, emailVerified: false },
        userId: null,
      }),
    ).rejects.toThrow(/verified email is required/);
  });

  test("rejects a profile without an email", async () => {
    const t = setup();
    await expect(
      t.mutation(internal.users.createOrUpdateUser, {
        provider: "google",
        providerAccountId: googleProfile.id,
        profile: { id: googleProfile.id, emailVerified: true },
        userId: null,
      }),
    ).rejects.toThrow(/verified email is required/);
  });

  test("echoes the userId back on repeat sign-ins", async () => {
    const t = setup();
    const userId = await t.mutation(internal.users.createOrUpdateUser, {
      provider: "google",
      providerAccountId: googleProfile.id,
      profile: googleProfile,
      userId: null,
    });
    const echoed = await t.mutation(internal.users.createOrUpdateUser, {
      provider: "google",
      providerAccountId: googleProfile.id,
      profile: googleProfile,
      userId,
    });
    expect(echoed).toBe(userId);
  });
});
