import {
  DataModelFromSchemaDefinition,
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
  TableNamesInDataModel,
  defineSchema,
  defineTable,
} from "convex/server";
import { GenericId, v } from "convex/values";
import { GenericDoc } from "../convex_types.js";

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
   * Refresh tokens are generally meant to be used once, to be exchanged for another
   * refresh token and a JWT access token, but with a few exceptions:
   * - The "active refresh token" is the most recently created refresh token that has
   *   not been used yet. The parent of the active refresh token can always be used to
   *   obtain the active refresh token.
   * - A refresh token can be used within a 10 second window ("reuse window") to
   *   obtain a new refresh token.
   * - On any invalid use of a refresh token, the token itself and all its descendants
   *   are invalidated.
   */
  authRefreshTokens: defineTable({
    sessionId: v.id("authSessions"),
    expirationTime: v.number(),
    firstUsedTime: v.optional(v.number()),
    // This is the ID of the refresh token that was exchanged to create this one.
    parentRefreshTokenId: v.optional(v.id("authRefreshTokens")),
  })
    // Sort by creationTime
    .index("sessionId", ["sessionId"])
    .index("sessionIdAndParentRefreshTokenId", [
      "sessionId",
      "parentRefreshTokenId",
    ]),
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
export type QueryCtx = GenericQueryCtx<AuthDataModel>;
export type Doc<T extends TableNamesInDataModel<AuthDataModel>> = GenericDoc<
  AuthDataModel,
  T
>;

export type Tokens = { token: string; refreshToken: string };
export type SessionInfo = {
  userId: GenericId<"users">;
  sessionId: GenericId<"authSessions">;
  tokens: Tokens | null;
};
export type SessionInfoWithTokens = {
  userId: GenericId<"users">;
  sessionId: GenericId<"authSessions">;
  tokens: Tokens;
};

// =============================================================================
// Trigger Types
// =============================================================================

/**
 * Table names managed by the auth library, derived from authTables.
 * Use these for type-safe trigger configurations.
 */
export type AuthTableName = keyof typeof authTables;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCtx = any;

/**
 * Trigger handler called when a document is created.
 * Omit the doc parameter to skip the read.
 */
export type OnCreateTrigger<TableName extends AuthTableName> =
  | ((ctx: AnyCtx) => Promise<void>)
  | ((ctx: AnyCtx, doc: Doc<TableName>) => Promise<void>);

/**
 * Trigger handler called when a document is updated.
 * Omit oldDoc to skip reading the old document.
 * Omit both to skip all reads.
 */
export type OnUpdateTrigger<TableName extends AuthTableName> =
  | ((ctx: AnyCtx) => Promise<void>)
  | ((ctx: AnyCtx, newDoc: Doc<TableName>) => Promise<void>)
  | ((ctx: AnyCtx, newDoc: Doc<TableName>, oldDoc: Doc<TableName>) => Promise<void>);

/**
 * Trigger handler called when a document is deleted.
 * Omit doc to skip reading the document before deletion.
 */
export type OnDeleteTrigger<TableName extends AuthTableName> =
  | ((ctx: AnyCtx, id: GenericId<TableName>) => Promise<void>)
  | ((ctx: AnyCtx, id: GenericId<TableName>, doc: Doc<TableName> | null) => Promise<void>);

/**
 * Trigger configuration for a single table.
 */
export type TableTriggers<TableName extends AuthTableName> = {
  onCreate?: OnCreateTrigger<TableName>;
  onUpdate?: OnUpdateTrigger<TableName>;
  onDelete?: OnDeleteTrigger<TableName>;
};

/**
 * Configuration for auth table triggers.
 * Triggers run in the same transaction as the auth operation,
 * allowing for atomic audit logging, history tracking, etc.
 *
 * @example
 * ```ts
 * import { convexAuth } from "@convex-dev/auth/server";
 *
 * export const { auth, signIn, signOut, store } = convexAuth({
 *   providers: [Password],
 *   triggers: {
 *     users: {
 *       onCreate: async (ctx, doc) => {
 *         console.log("User created:", doc._id);
 *       },
 *       onUpdate: async (ctx, newDoc, oldDoc) => {
 *         console.log("User updated:", newDoc._id);
 *       },
 *     },
 *     authAccounts: {
 *       onCreate: async (ctx, doc) => {
 *         console.log("Account created:", doc._id);
 *       },
 *     },
 *   },
 * });
 * ```
 */
export type AuthTriggers = {
  [K in AuthTableName]?: TableTriggers<K>;
};
