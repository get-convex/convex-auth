import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { defineSchema, defineTable } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { FunctionReference } from "convex/server";
import { setupUsernamePassword, type CompleteSignIn } from "./setup.js";
import type { ComponentApi } from "./_generated/component.js";
import schema from "./setupTestSchema.js";

const modules = import.meta.glob("./**/*.ts");
const PASSWORD = "correct horse battery staple";

type UsernamePasswordMutation = FunctionReference<
  "mutation",
  "public",
  { username: string; password: string },
  | {
      success: true;
      tokens: {
        accessToken: string;
        accessTokenExpiresAt: number;
        refreshToken: string;
        refreshTokenExpiresAt: number;
        userId: string;
      };
    }
  | {
      success: false;
      userError: { error: string } & Record<string, unknown>;
    }
>;

const signUpWithPassword = makeFunctionReference(
  "setupTestApp:signUpWithPassword",
) as UsernamePasswordMutation;
const signInWithPassword = makeFunctionReference(
  "setupTestApp:signInWithPassword",
) as UsernamePasswordMutation;

function setup() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

describe("setupUsernamePassword", () => {
  test("signs up a username user and stores a usable password", async () => {
    const t = setup();
    const result = await t.mutation(signUpWithPassword, {
      username: "alice",
      password: PASSWORD,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.tokens.userId).toBe("alice");
    }

    const rows = await t.run(async (ctx) => ({
      users: await ctx.db.query("users").collect(),
      passwords: await ctx.db.query("passwords").collect(),
    }));
    expect(rows.users).toHaveLength(1);
    expect(rows.users[0].username).toBe("alice");
    expect(rows.passwords).toHaveLength(1);
    expect(rows.passwords[0].userId).toBe(rows.users[0]._id);

    const signIn = await t.mutation(signInWithPassword, {
      username: "alice",
      password: PASSWORD,
    });
    expect(signIn.success).toBe(true);
  });

  test("returns a user error for duplicate usernames", async () => {
    const t = setup();
    await t.mutation(signUpWithPassword, {
      username: "alice",
      password: PASSWORD,
    });
    const result = await t.mutation(signUpWithPassword, {
      username: "alice",
      password: PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "USERNAME_ALREADY_EXISTS" },
    });
  });

  test("returns invalid credentials for unknown usernames and wrong passwords", async () => {
    const t = setup();
    expect(
      await t.mutation(signInWithPassword, {
        username: "alice",
        password: PASSWORD,
      }),
    ).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });

    await t.mutation(signUpWithPassword, {
      username: "alice",
      password: PASSWORD,
    });
    expect(
      await t.mutation(signInWithPassword, {
        username: "alice",
        password: "wrong horse battery staple",
      }),
    ).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("does not create a user when password validation fails", async () => {
    const t = setup();
    const result = await t.mutation(signUpWithPassword, {
      username: "alice",
      password: "short",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(0);
  });
});

const component = null as unknown as ComponentApi;
const completeSignIn = (async () => ({
  accessToken: "",
  accessTokenExpiresAt: 0,
  refreshToken: "",
  refreshTokenExpiresAt: 0,
  userId: "",
})) satisfies CompleteSignIn;

const validSchema = defineSchema({
  users: defineTable({
    username: v.string(),
  }).index("by_username", ["username"]),
});
setupUsernamePassword({ schema: validSchema, component, completeSignIn });

const optionalExtraFieldsSchema = defineSchema({
  users: defineTable({
    username: v.string(),
    displayName: v.optional(v.string()),
  }).index("by_username", ["username"]),
});
setupUsernamePassword({
  schema: optionalExtraFieldsSchema,
  component,
  completeSignIn,
});

const missingUsersSchema = defineSchema({
  accounts: defineTable({
    username: v.string(),
  }).index("by_username", ["username"]),
});
// @ts-expect-error setupUsernamePassword requires a users table.
setupUsernamePassword({ schema: missingUsersSchema, component, completeSignIn });

const missingUsernameSchema = defineSchema({
  users: defineTable({
    name: v.string(),
  }).index("by_name", ["name"]),
});
setupUsernamePassword({
  // @ts-expect-error setupUsernamePassword requires users.username.
  schema: missingUsernameSchema,
  component,
  completeSignIn,
});

const nonStringUsernameSchema = defineSchema({
  users: defineTable({
    username: v.number(),
  }).index("by_username", ["username"]),
});
setupUsernamePassword({
  // @ts-expect-error setupUsernamePassword requires users.username to be a string.
  schema: nonStringUsernameSchema,
  component,
  completeSignIn,
});

const missingUsernameIndexSchema = defineSchema({
  users: defineTable({
    username: v.string(),
  }),
});
setupUsernamePassword({
  // @ts-expect-error setupUsernamePassword requires a by_username index.
  schema: missingUsernameIndexSchema,
  component,
  completeSignIn,
});

const wrongUsernameIndexSchema = defineSchema({
  users: defineTable({
    username: v.string(),
    displayName: v.string(),
  }).index("by_username", ["displayName"]),
});
setupUsernamePassword({
  // @ts-expect-error by_username must start with username.
  schema: wrongUsernameIndexSchema,
  component,
  completeSignIn,
});

const requiredExtraFieldSchema = defineSchema({
  users: defineTable({
    username: v.string(),
    displayName: v.string(),
  }).index("by_username", ["username"]),
});
setupUsernamePassword({
  // @ts-expect-error sign-up inserts only username, so extra user fields must be optional.
  schema: requiredExtraFieldSchema,
  component,
  completeSignIn,
});
