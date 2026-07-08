import {
  mutationGeneric,
  type DataModelFromSchemaDefinition,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericSchema,
  type MutationBuilder,
  type SchemaDefinition,
} from "convex/server";
import { Infer, v } from "convex/values";
import type { ComponentApi } from "./_generated/component.js";
import {
  type AuthClaims,
  type TokenBundle,
  vTokenBundle,
} from "../../lib/types.js";
import { validatePasswordInputFormat } from "./validation.js";

type CompleteSignInCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;

export type CompleteSignIn = (
  ctx: CompleteSignInCtx,
  claims: AuthClaims,
) => Promise<TokenBundle>;

type RequiredKeys<T> = {
  [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K;
}[keyof T];

type UsernamePasswordSchemaConstraint<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
> =
  DataModelFromSchemaDefinition<Schema> extends infer DataModel extends GenericDataModel
    ? "users" extends keyof DataModel
      ? DataModel["users"]["document"] extends { username: string }
        ? "by_username" extends keyof DataModel["users"]["indexes"]
          ? DataModel["users"]["indexes"]["by_username"] extends [
              "username",
              ...string[],
            ]
            ? Exclude<
                RequiredKeys<DataModel["users"]["document"]>,
                "_id" | "_creationTime" | "username"
              > extends never
              ? Schema
              : never
            : never
          : never
        : never
      : never
    : never;

type UsernamePasswordDataModel<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
> = DataModelFromSchemaDefinition<Schema>;

type UsernameUser = {
  _id: string;
  username: string;
};

type UsernameIndexBuilder = {
  eq(field: "username", value: string): unknown;
};

type UsernameQuery = {
  withIndex(
    indexName: "by_username",
    range: (q: UsernameIndexBuilder) => unknown,
  ): {
    unique(): Promise<UsernameUser | null>;
  };
};

const usernamePasswordUserError = v.union(
  v.object({
    error: v.literal("PASSWORD_TOO_SHORT"),
    minimumLength: v.number(),
  }),
  v.object({
    error: v.literal("PASSWORD_TOO_LONG"),
    maximumLength: v.number(),
  }),
  v.object({ error: v.literal("PASSWORD_HAS_SURROUNDING_WHITESPACE") }),
  v.object({ error: v.literal("INVALID_CREDENTIALS") }),
  v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
  v.object({ error: v.literal("USERNAME_ALREADY_EXISTS") }),
);

const usernamePasswordResult = v.union(
  v.object({ success: v.literal(true), tokens: vTokenBundle }),
  v.object({
    success: v.literal(false),
    userError: usernamePasswordUserError,
  }),
);

type UsernamePasswordResult = Infer<typeof usernamePasswordResult>;

export function setupUsernamePassword<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(opts: {
  schema: Schema & UsernamePasswordSchemaConstraint<Schema>;
  component: ComponentApi;
  completeSignIn: CompleteSignIn;
}) {
  const { component, completeSignIn } = opts;
  type DataModel = UsernamePasswordDataModel<Schema>;
  const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;

  const claims = (username: string): AuthClaims => ({
    provider: "password",
    providerAccountId: username,
    profile: { username },
  });

  const signInWithPassword = mutation({
    args: { username: v.string(), password: v.string() },
    returns: usernamePasswordResult,
    handler: async (ctx, args): Promise<UsernamePasswordResult> => {
      const user = await (ctx.db.query("users") as unknown as UsernameQuery)
        .withIndex("by_username", (q) => q.eq("username", args.username))
        .unique();
      if (user === null) {
        return {
          success: false,
          userError: { error: "INVALID_CREDENTIALS" },
        };
      }

      const verified = await ctx.runMutation(component.public.verifyPassword, {
        userId: user._id,
        password: args.password,
      });
      if (!verified.success) {
        return verified;
      }

      return {
        success: true,
        tokens: await completeSignIn(ctx, claims(args.username)),
      };
    },
  });

  const signUpWithPassword = mutation({
    args: { username: v.string(), password: v.string() },
    returns: usernamePasswordResult,
    handler: async (ctx, args): Promise<UsernamePasswordResult> => {
      const passwordUserError = validatePasswordInputFormat(args.password);
      if (passwordUserError !== null) {
        return { success: false, userError: passwordUserError };
      }

      const existing = await (ctx.db.query("users") as unknown as UsernameQuery)
        .withIndex("by_username", (q) => q.eq("username", args.username))
        .unique();
      if (existing !== null) {
        return {
          success: false,
          userError: { error: "USERNAME_ALREADY_EXISTS" },
        };
      }

      const userId = await (ctx.db.insert("users" as never, {
        username: args.username,
      } as never) as Promise<string>);
      const setPassword = await ctx.runMutation(component.public.setPassword, {
        userId,
        password: args.password,
      });
      if (!setPassword.success) {
        throw new Error("Password passed setup validation but was rejected.");
      }

      return {
        success: true,
        tokens: await completeSignIn(ctx, claims(args.username)),
      };
    },
  });

  return {
    signInWithPassword,
    signUpWithPassword,
  };
}
