import {
  DataModelFromSchemaDefinition,
  FunctionReference,
  GenericActionCtx,
  GenericMutationCtx,
  defineSchema,
  defineTable,
} from "convex/server";
import { ObjectType, v } from "convex/values";

/**
 * The table definitions required by the library.
 *
 * Your schema must include these so that the indexes
 * are set up:
 *
 *
 * ```ts filename="convex/schema.ts"
 * import { defineSchema } from "convex/server";
 * import { authTables } from "@convex-dev/auth/server";
 *
 * const schema = defineSchema({
 *   ...authTables,
 * });
 *
 * export default schema;
 * ```
 *
 * You can inline the table definitions into your schema
 * and extend them with additional optional and required
 * fields. See https://labs.convex.dev/auth/setup/schema
 * for more details.
 */
export const authTables = {
  /**
   * Users.
   */
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),
  /**
   * Sessions.
   * A single user can have multiple active sessions.
   * See [Session document lifecycle](https://labs.convex.dev/auth/advanced#session-document-lifecycle).
   */
  authSessions: defineTable({
    userId: v.id("users"),
    expirationTime: v.number(),
  }).index("userId", ["userId"]),
  /**
   * Accounts. An account corresponds to
   * a single authentication provider.
   * A single user can have multiple accounts linked.
   */
  authAccounts: defineTable({
    userId: v.id("users"),
    provider: v.string(),
    providerAccountId: v.string(),
    secret: v.optional(v.string()),
    emailVerified: v.optional(v.string()),
    phoneVerified: v.optional(v.string()),
  })
    .index("userIdAndProvider", ["userId", "provider"])
    .index("providerAndAccountId", ["provider", "providerAccountId"]),
  /**
   * Refresh tokens.
   * Each session has only a single refresh token
   * valid at a time. Refresh tokens are rotated
   * and reuse is not allowed.
   */
  authRefreshTokens: defineTable({
    sessionId: v.id("authSessions"),
    expirationTime: v.number(),
  }).index("sessionId", ["sessionId"]),
  /**
   * Verification codes:
   * - OTP tokens
   * - magic link tokens
   * - OAuth codes
   */
  authVerificationCodes: defineTable({
    accountId: v.id("authAccounts"),
    provider: v.string(),
    code: v.string(),
    expirationTime: v.number(),
    verifier: v.optional(v.string()),
    emailVerified: v.optional(v.string()),
    phoneVerified: v.optional(v.string()),
  })
    .index("accountId", ["accountId"])
    .index("code", ["code"]),
  /**
   * PKCE verifiers for OAuth.
   */
  authVerifiers: defineTable({
    sessionId: v.optional(v.id("authSessions")),
    signature: v.optional(v.string()),
  }).index("signature", ["signature"]),
  /**
   * Rate limits for OTP and password sign-in.
   */
  authRateLimits: defineTable({
    identifier: v.string(),
    lastAttemptTime: v.number(),
    attemptsLeft: v.number(),
  }).index("identifier", ["identifier"]),
};

const defaultSchema = defineSchema(authTables);

export type AuthDataModel = DataModelFromSchemaDefinition<typeof defaultSchema>;
export type ActionCtx = GenericActionCtx<AuthDataModel>;
export type MutationCtx = GenericMutationCtx<AuthDataModel>;

export const storeArgs = {
  args: v.union(
    v.object({
      type: v.literal("signIn"),
      userId: v.id("users"),
      sessionId: v.optional(v.id("authSessions")),
      generateTokens: v.boolean(),
    }),
    v.object({
      type: v.literal("signOut"),
    }),
    v.object({
      type: v.literal("refreshSession"),
      refreshToken: v.string(),
    }),
    v.object({
      type: v.literal("verifyCodeAndSignIn"),
      params: v.any(),
      provider: v.optional(v.string()),
      verifier: v.optional(v.string()),
      generateTokens: v.boolean(),
      allowExtraProviders: v.boolean(),
    }),
    v.object({
      type: v.literal("verifier"),
    }),
    v.object({
      type: v.literal("verifierSignature"),
      verifier: v.string(),
      signature: v.string(),
    }),
    v.object({
      type: v.literal("userOAuth"),
      provider: v.string(),
      providerAccountId: v.string(),
      profile: v.any(),
      signature: v.string(),
    }),
    v.object({
      type: v.literal("createVerificationCode"),
      accountId: v.optional(v.id("authAccounts")),
      provider: v.string(),
      email: v.optional(v.string()),
      phone: v.optional(v.string()),
      code: v.string(),
      expirationTime: v.number(),
      allowExtraProviders: v.boolean(),
    }),
    v.object({
      type: v.literal("createAccountFromCredentials"),
      provider: v.string(),
      account: v.object({ id: v.string(), secret: v.optional(v.string()) }),
      profile: v.any(),
      shouldLinkViaEmail: v.optional(v.boolean()),
      shouldLinkViaPhone: v.optional(v.boolean()),
    }),
    v.object({
      type: v.literal("retrieveAccountWithCredentials"),
      provider: v.string(),
      account: v.object({ id: v.string(), secret: v.optional(v.string()) }),
    }),
    v.object({
      type: v.literal("modifyAccount"),
      provider: v.string(),
      account: v.object({ id: v.string(), secret: v.string() }),
    }),
    v.object({
      type: v.literal("invalidateSessions"),
      userId: v.id("users"),
      except: v.optional(v.array(v.id("authSessions"))),
    }),
  ),
};

export const internal: {
  auth: {
    store: FunctionReference<
      "mutation",
      "internal",
      ObjectType<typeof storeArgs>,
      any
    >;
  };
} = {
  auth: {
    store: "auth:store" as any,
  },
};
