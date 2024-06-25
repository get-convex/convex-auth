import { OAuth2Config, OAuthConfig } from "@auth/core/providers";
import { TokenSet } from "@auth/core/types";
import { generateState } from "arctic";
import {
  Auth,
  DataModelFromSchemaDefinition,
  DocumentByName,
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  HttpRouter,
  PublicHttpAction,
  WithoutSystemFields,
  actionGeneric,
  defineSchema,
  defineTable,
  httpActionGeneric,
  internalMutationGeneric,
} from "convex/server";
import { ConvexError, GenericId, ObjectType, Value, v } from "convex/values";
import * as cookie from "cookie";
import { SignJWT, importPKCS8 } from "jose";
import {
  alphabet,
  generateRandomString,
  sha256 as rawSha256,
} from "oslo/crypto";
import { encodeHex } from "oslo/encoding";
import { OAuth2Client } from "oslo/oauth2";
import { FunctionReferenceFromExport, GenericDoc } from "./convex_types.js";
import {
  configDefaults,
  getOAuthURLs,
  materializeProvider,
} from "./provider_utils.js";
import {
  AuthProviderConfig,
  AuthProviderMaterializedConfig,
  ConvexAuthConfig,
  ConvexCredentialsConfig,
  GenericActionCtxWithAuthConfig,
} from "./types.js";

const DEFAULT_EMAIL_VERIFICATION_CODE_DURATION_S = 60 * 60 * 24; // 24 hours
const DEFAULT_SESSION_TOTAL_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const DEFAULT_SESSION_INACTIVE_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const DEFAULT_JWT_DURATION_MS = 1000 * 60 * 60; // 1 hour
const OAUTH_SIGN_IN_EXPIRATION_MS = 1000 * 60 * 2; // 2 minutes
const MIN_CODE_LENGTH_TO_SKIP_IDENTIFIER_CHECK = 24;
const DEFAULT_MAX_SIGN_IN_ATTEMPS_PER_HOUR = 10;
const REFRESH_TOKEN_DIVIDER = "|";
const TOKEN_SUB_CLAIM_DIVIDER = "|";

/**
 * The table definitions required by the library.
 *
 * Your schema must include these so that the indexes
 * are set up:
 *
 *
 * ```ts filename="convex/schema.ts"
 * import { defineSchema } from "convex/server";
 * import { authTables } from "@xixixao/convex-auth/server";
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
  sessions: defineTable({
    userId: v.id("users"),
    expirationTime: v.number(),
  }).index("userId", ["userId"]),
  /**
   * Accounts. An account corresponds to
   * a single authentication provider.
   * A single user can have multiple accounts linked.
   */
  accounts: defineTable({
    userId: v.id("users"),
    type: v.union(
      v.literal("oauth"),
      v.literal("oidc"),
      v.literal("email"),
      v.literal("webauthn"),
      v.literal("credentials"),
    ),
    provider: v.string(),
    providerAccountId: v.string(),
    secret: v.optional(v.string()),
    emailVerified: v.boolean(),
    phoneVerified: v.boolean(),
  })
    .index("providerAndUserId", ["provider", "userId"])
    .index("providerAndAccountId", ["provider", "providerAccountId"]),
  /**
   * Refresh tokens.
   * Each session has only a single refresh token
   * valid at a time. Refresh tokens are rotated
   * and reuse is not allowed.
   */
  authRefreshTokens: defineTable({
    sessionId: v.id("sessions"),
    expirationTime: v.number(),
  }).index("sessionId", ["sessionId"]),
  /**
   * Verification codes:
   * - OTP tokens
   * - magic link tokens
   * - OAuth codes
   */
  authVerificationCodes: defineTable({
    accountId: v.id("accounts"),
    code: v.string(),
    expirationTime: v.number(),
    verifier: v.optional(v.string()),
    emailVerified: v.optional(v.boolean()),
    phoneVerified: v.optional(v.boolean()),
  })
    .index("accountId", ["accountId"])
    .index("code", ["code"]),
  /**
   * PKCE verifiers.
   */
  authVerifiers: defineTable({
    state: v.string(),
    verifier: v.string(),
  }).index("state", ["state"]),
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

type AuthDataModel = DataModelFromSchemaDefinition<typeof defaultSchema>;

const storeArgs = {
  args: v.union(
    v.object({
      type: v.literal("signIn"),
      userId: v.id("users"),
      sessionId: v.optional(v.id("sessions")),
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
      code: v.string(),
      verifier: v.optional(v.string()),
      identifier: v.optional(v.string()),
      generateTokens: v.boolean(),
    }),
    v.object({
      type: v.literal("getProviderAccountId"),
      userId: v.id("users"),
      provider: v.string(),
    }),
    v.object({
      type: v.literal("verifier"),
      verifier: v.string(),
      state: v.string(),
    }),
    v.object({
      type: v.literal("userOAuth"),
      provider: v.string(),
      providerAccountId: v.string(),
      profile: v.any(),
      state: v.string(),
    }),
    v.object({
      type: v.literal("createVerificationCode"),
      accountId: v.optional(v.id("accounts")),
      provider: v.string(),
      email: v.optional(v.string()),
      phone: v.optional(v.string()),
      code: v.string(),
      expirationTime: v.number(),
    }),
    v.object({
      type: v.literal("createAccountFromCredentials"),
      provider: v.string(),
      account: v.object({ id: v.string(), secret: v.optional(v.string()) }),
      profile: v.any(),
      emailVerified: v.optional(v.boolean()),
      phoneVerified: v.optional(v.boolean()),
      shouldLink: v.boolean(),
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
      except: v.optional(v.array(v.id("sessions"))),
    }),
  ),
};

const internal: {
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

/**
 * @internal
 */
export type SignInAction = FunctionReferenceFromExport<
  ReturnType<typeof convexAuth>["signIn"]
>;
/**
 * @internal
 */
export type SignOutAction = FunctionReferenceFromExport<
  ReturnType<typeof convexAuth>["signOut"]
>;

/**
 * Configure the Convex Auth library. Returns an object with
 * functions and `auth` helper. You must export the functions
 * from `convex/auth.ts` to make them callable:
 *
 * ```ts filename="convex/auth.ts"
 * import { convexAuth } from "@xixixao/convex-auth/server";
 *
 * export const { auth, signIn, signOut, store } = convexAuth({
 *   providers: [],
 * });
 * ```
 *
 * @returns An object with `auth` helper for configuring HTTP actions and accessing
 * the current user and session ID.
 */
export function convexAuth(config_: ConvexAuthConfig) {
  const config = configDefaults(config_);
  const hasOAuth = config.providers.some(
    (provider) => provider.type === "oauth" || provider.type === "oidc",
  );
  const getProvider = (id: string) => {
    return config.providers.find((provider) => provider.id === id);
  };
  const getProviderOrThrow = (id: string) => {
    const provider = getProvider(id);
    if (provider === undefined) {
      console.error(`Provider ${id} is not configured`);
      throw new Error(`Provider ${id} is not configured`);
    }
    return provider;
  };
  const enrichCtx = <DataModel extends GenericDataModel>(
    ctx: GenericActionCtx<DataModel>,
  ) => ({ ...ctx, auth: { ...ctx.auth, config } });

  const auth = {
    /**
     * Return the currently signed-in user's ID.
     *
     * ```ts filename="convex/myFunctions.tsx"
     * import { mutation } from "./_generated/server";
     * import { auth } from "./auth.js";
     *
     * export const currentUser = mutation({
     *   args: {/* ... *\/},
     *   handler: async (ctx, args) => {
     *     const userId = await auth.getUserId(ctx);
     *     if (userId === null) {
     *       throw new Error("User is not authenticated!")
     *     }
     *     const user = await ctx.db.get(userId);
     *     // ...
     *   },
     * });
     * ```
     *
     * @param ctx query, mutation or action `ctx`
     * @returns the user ID or `null` if the client isn't authenticated
     */
    getUserId: async (ctx: { auth: Auth }) => {
      const identity = await ctx.auth.getUserIdentity();
      if (identity === null) {
        return null;
      }
      const [userId] = identity.subject.split(TOKEN_SUB_CLAIM_DIVIDER);
      return userId as GenericId<"users">;
    },
    /**
     * Return the current session ID.
     *
     * ```ts filename="convex/myFunctions.tsx"
     * import { mutation } from "./_generated/server";
     * import { auth } from "./auth.js";
     *
     * export const currentSession = mutation({
     *   args: {/* ... *\/},
     *   handler: async (ctx, args) => {
     *     const sessionId = await auth.getSessionId(ctx);
     *     if (sessionId === null) {
     *       throw new Error("Session is not authenticated!")
     *     }
     *     const session = await ctx.db.get(sessionId);
     *     // ...
     *   },
     * });
     * ```
     *
     * @param ctx query, mutation or action `ctx`
     * @returns the session ID or `null` if the client isn't authenticated
     */
    getSessionId: async (ctx: { auth: Auth }) => {
      const identity = await ctx.auth.getUserIdentity();
      if (identity === null) {
        return null;
      }
      const [, sessionId] = identity.subject.split(TOKEN_SUB_CLAIM_DIVIDER);
      return sessionId as GenericId<"sessions">;
    },
    /**
     * Add HTTP actions for JWT verification and OAuth sign-in.
     *
     * ```ts
     * import { httpRouter } from "convex/server";
     * import { auth } from "./auth.js";
     *
     * const http = httpRouter();
     *
     * auth.addHttpRoutes(http);
     *
     * export default http;
     * ```
     *
     * The following routes are handled always:
     *
     * - `/.well-known/openid-configuration`
     * - `/.well-known/jwks.json`
     *
     * The following routes are handled if OAuth is configured:
     *
     * - `/api/auth/signin/*`
     * - `/api/auth/callback/*`
     *
     * @param http your HTTP router
     */
    addHttpRoutes: (http: HttpRouter) => {
      const httpWithCors = corsRoutes(http, siteUrl);
      http.route({
        path: "/.well-known/openid-configuration",
        method: "GET",
        handler: httpActionGeneric(async () => {
          return new Response(
            JSON.stringify({
              issuer: process.env.CONVEX_SITE_URL,
              jwks_uri: process.env.CONVEX_SITE_URL + "/.well-known/jwks.json",
              authorization_endpoint:
                process.env.CONVEX_SITE_URL + "/oauth/authorize",
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Cache-Control":
                  "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400",
              },
            },
          );
        }),
      });

      http.route({
        path: "/.well-known/jwks.json",
        method: "GET",
        handler: httpActionGeneric(async () => {
          return new Response(process.env.JWKS, {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control":
                "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400",
            },
          });
        }),
      });

      if (hasOAuth) {
        httpWithCors.route({
          pathPrefix: "/api/auth/signin/",
          method: "GET",
          credentials: true,
          handler: httpActionGeneric(
            convertErrorsToResponse(400, async (ctx, request) => {
              const url = new URL(request.url);
              const pathParts = url.pathname.split("/");
              const providerId = pathParts.at(-1)!;
              if (providerId === null) {
                throw new Error("Missing provider id");
              }
              const verifier = url.searchParams.get("code");
              if (verifier === null) {
                throw new Error("Missing sign-in verifier");
              }
              const provider = getProviderOrThrow(
                providerId,
              ) as OAuthConfig<any>;
              if (provider.clientId === undefined) {
                throw new Error(
                  `Missing \`clientId\`, set ${clientId(providerId)}`,
                );
              }
              if (provider.clientSecret === undefined) {
                throw new Error(
                  `Missing \`clientSecret\`, set ${clientSecret(providerId)}`,
                );
              }

              const state = generateState();

              const { authorization } = await getOAuthURLs(provider);
              const destinationUrl = new URL(authorization.url);
              for (const [key, value] of Object.entries({
                response_type: "code",
                client_id: provider.clientId,
                redirect_uri:
                  process.env.CONVEX_SITE_URL +
                  "/api/auth/callback/" +
                  providerId,
                state,
                ...(provider.type === "oidc" &&
                !destinationUrl.searchParams.has("scope")
                  ? { scope: "openid profile email" }
                  : null),
              })) {
                destinationUrl.searchParams.set(key, value as any);
              }

              await ctx.runMutation(internal.auth.store, {
                args: {
                  type: "verifier",
                  verifier,
                  state,
                },
              });

              return new Response(null, {
                status: 302,
                headers: {
                  Location: destinationUrl.toString(),
                  "Set-Cookie": cookie.serialize(
                    oauthStateCookieName(providerId),
                    state,
                    {
                      httpOnly: true,
                      sameSite: "none",
                      secure: true,
                      path: "/",
                      partitioned: true,
                      maxAge: 60 * 10, // 10 minutes
                    },
                  ),
                },
              });
            }),
          ),
        });

        http.route({
          pathPrefix: "/api/auth/callback/",
          method: "GET",
          handler: httpActionGeneric(async (ctx, request) => {
            const url = new URL(request.url);
            const pathParts = url.pathname.split("/");
            const providerId = pathParts.at(-1)!;
            const provider = getProviderOrThrow(
              providerId,
            ) as OAuth2Config<any>;

            const code = url.searchParams.get("code");
            const state = url.searchParams.get("state");
            const storedState =
              getCookies(request)[oauthStateCookieName(providerId)];

            if (code === null || state === null || state !== storedState) {
              console.error(
                `Invalid code or state in ${providerId} auth callback`,
              );
              return Response.redirect(siteAfterLoginUrl());
            }

            try {
              if (provider.clientId === undefined) {
                throw new Error(
                  `Missing \`clientId\`, set ${clientId(providerId)}`,
                );
              }
              if (provider.clientSecret === undefined) {
                throw new Error(
                  `Missing \`clientSecret\`, set ${clientSecret(providerId)}`,
                );
              }
              const { token, userinfo } = await getOAuthURLs(provider);
              const client = new OAuth2Client(
                provider.clientId,
                "",
                token.url,
                {
                  redirectURI:
                    process.env.CONVEX_SITE_URL +
                    "/api/auth/callback/" +
                    providerId,
                },
              );
              const tokens = (await client.validateAuthorizationCode(code, {
                authenticateWith: "request_body",
                credentials: provider.clientSecret,
              })) as TokenSet;

              let profile;
              if (userinfo?.request) {
                profile = await userinfo.request({ tokens, provider });
              } else if (userinfo?.url) {
                const response = await fetch(userinfo?.url, {
                  headers: {
                    Authorization: `Bearer ${tokens.access_token}`,
                    "User-Agent": "convex/auth",
                  },
                });
                profile = await response.json();
              } else {
                throw new Error(
                  `No userinfo endpoint configured in provider ${providerId}`,
                );
              }

              const { id, ...profileFromCallback } = await provider.profile!(
                profile,
                tokens,
              );

              const verificationCode = await ctx.runMutation(
                internal.auth.store,
                {
                  args: {
                    type: "userOAuth",
                    provider: providerId,
                    providerAccountId: id!,
                    profile: profileFromCallback,
                    state,
                  },
                },
              );
              const destinationUrl = new URL(siteAfterLoginUrl());
              destinationUrl.searchParams.set(
                "code",
                verificationCode as string,
              );
              return new Response(null, {
                status: 302,
                headers: {
                  Location: destinationUrl.toString(),
                  "Cache-Control": "must-revalidate",
                },
              });
            } catch (error) {
              console.error(error);
              return Response.redirect(siteAfterLoginUrl());
            }
          }),
        });
      }
    },
  };
  return {
    /**
     * Helper for configuring HTTP actions and accessing
     * the current user and session ID.
     */
    auth,
    /**
     * Action called by the client to sign the user in.
     *
     * Also used for refreshing the session.
     */
    signIn: actionGeneric({
      args: {
        provider: v.optional(v.string()),
        params: v.optional(v.any()),
        verifier: v.optional(v.string()),
        refreshToken: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        const provider =
          args.provider !== undefined
            ? getProviderOrThrow(args.provider)
            : null;
        const result = await signInImpl(enrichCtx(ctx), provider, args, {
          generateTokens: true,
        });
        return result.redirect !== undefined
          ? { redirect: result.redirect }
          : result.started !== undefined
            ? { started: result.started }
            : { tokens: result.signedIn?.tokens ?? null };
      },
    }),
    /**
     * Action called by the client to invalidate the current session.
     */
    signOut: actionGeneric({
      args: {},
      handler: async (ctx) => {
        await ctx.runMutation(internal.auth.store, {
          args: { type: "signOut" },
        });
      },
    }),

    /**
     * Internal mutation used by the library to read and write
     * to the database during signin and signout.
     */
    store: internalMutationGeneric({
      args: storeArgs,
      handler: async (ctx: GenericMutationCtx<AuthDataModel>, { args }) => {
        // console.debug(args);
        switch (args.type) {
          case "signIn": {
            const {
              userId,
              sessionId: existingSessionId,
              generateTokens,
            } = args;
            const sessionId =
              existingSessionId ??
              (await createNewAndDeleteExistingSession(
                ctx,
                config,
                auth,
                userId,
              ));
            return await maybeGenerateTokensForSession(
              ctx,
              config,
              userId,
              sessionId,
              generateTokens,
            );
          }
          case "signOut": {
            const sessionId = await auth.getSessionId(ctx);
            if (sessionId !== null) {
              const session = await ctx.db.get(sessionId);
              if (session !== null) {
                await deleteSession(ctx, session);
                return { userId: session.userId, sessionId: session._id };
              }
            }
            return null;
          }
          case "refreshSession": {
            const { refreshToken } = args;
            const [refreshTokenId, tokenSessionId] = refreshToken.split(
              REFRESH_TOKEN_DIVIDER,
            );
            const validationResult = await validateRefreshToken(
              ctx,
              refreshTokenId,
              tokenSessionId,
            );
            // This invalidates all other refresh tokens for this session,
            // including ones created later, regardless of whether
            // the passed one is valid or not.
            await deleteRefreshTokens(
              ctx,
              tokenSessionId as GenericId<"sessions">,
            );

            if (validationResult === null) {
              // Can't call `deleteSession` here because we already deleted
              // refresh tokens above
              const session = await ctx.db.get(
                tokenSessionId as GenericId<"sessions">,
              );
              if (session !== null) {
                await ctx.db.delete(session._id);
              }
              return null;
            }
            const { session } = validationResult;
            const sessionId = session._id;
            const userId = session.userId;
            return await generateTokensForSession(
              ctx,
              config,
              userId,
              sessionId,
            );
          }
          case "verifyCodeAndSignIn": {
            const { identifier, generateTokens } = args;
            if (identifier !== undefined) {
              if (await isSignInRateLimited(ctx, identifier, config)) {
                console.error(
                  "Too many failed attemps to verify code for this email",
                );
                return null;
              }
            }
            const verifyResult = await verifyCodeOnly(ctx, args);
            if (verifyResult === null) {
              if (identifier !== undefined) {
                await recordFailedSignIn(ctx, identifier, config);
              }
              return null;
            }
            if (identifier !== undefined) {
              await resetSignInRateLimit(ctx, identifier);
            }
            const { userId } = verifyResult;
            const sessionId = await createNewAndDeleteExistingSession(
              ctx,
              config,
              auth,
              userId,
            );
            return await maybeGenerateTokensForSession(
              ctx,
              config,
              userId,
              sessionId,
              generateTokens,
            );
          }
          case "getProviderAccountId": {
            const { userId, provider } = args;
            const account = await ctx.db
              .query("accounts")
              .withIndex("providerAndUserId", (q) =>
                q.eq("provider", provider).eq("userId", userId),
              )
              .unique();
            if (account === null) {
              throw new Error(
                `Expected an account to exist for user ID "${userId}" and provider "${provider}"`,
              );
            }
            return account.providerAccountId;
          }
          case "verifier": {
            const { verifier, state } = args;
            return await ctx.db.insert("authVerifiers", { verifier, state });
          }
          case "userOAuth": {
            const { profile, provider, providerAccountId, state } = args;
            const providerConfig = getProviderOrThrow(
              provider,
            ) as OAuthConfig<any>;
            const shouldLink =
              providerConfig.allowDangerousEmailAccountLinking !== false;

            const existingAccount = await ctx.db
              .query("accounts")
              .withIndex("providerAndAccountId", (q) =>
                q
                  .eq("provider", provider)
                  .eq("providerAccountId", providerAccountId),
              )
              .unique();

            const existingUserId =
              existingAccount !== null
                ? existingAccount.userId
                : shouldLink
                  ? (await uniqueUserWithVerifiedEmail(ctx, profile.email))
                      ?._id ?? null
                  : null;

            let userId: GenericId<"users">;
            if (existingUserId !== null) {
              await ctx.db.patch(existingUserId, profile);
              userId = existingUserId;
            } else {
              userId = await ctx.db.insert("users", profile);
            }
            const accountId =
              existingAccount?._id ??
              (await ctx.db.insert("accounts", {
                userId,
                provider,
                providerAccountId,
                type: "oauth",
                emailVerified: shouldLink,
                phoneVerified: false,
              }));

            const verifier = await ctx.db
              .query("authVerifiers")
              .withIndex("state", (q) => q.eq("state", state))
              .unique();
            if (verifier === null) {
              throw new Error("Invalid state");
            }
            const code = generateRandomString(8, alphabet("0-9"));
            await ctx.db.delete(verifier._id);
            const existingVerificationCode = await ctx.db
              .query("authVerificationCodes")
              .withIndex("accountId", (q) => q.eq("accountId", accountId))
              .unique();
            if (existingVerificationCode !== null) {
              await ctx.db.delete(existingVerificationCode._id);
            }
            await ctx.db.insert("authVerificationCodes", {
              code: await sha256(code),
              accountId,
              expirationTime: Date.now() + OAUTH_SIGN_IN_EXPIRATION_MS,
              verifier: verifier?.verifier,
              emailVerified: shouldLink,
            });
            return code;
          }
          case "createVerificationCode": {
            const {
              email,
              phone,
              code,
              expirationTime,
              provider,
              accountId: existingAccountId,
            } = args;
            let accountId: GenericId<"accounts">;
            if (existingAccountId !== undefined) {
              const existingAccount = await ctx.db.get(existingAccountId);
              if (existingAccount === null) {
                throw new Error(
                  `Expected an account to exist for ID "${existingAccountId}"`,
                );
              }
              const user = await ctx.db.get(existingAccount.userId);
              if (user === null) {
                throw new Error(
                  `Expected a user to exist for ID "${existingAccount.userId}"`,
                );
              }
              accountId = existingAccountId;
            } else {
              const existingAccount = await ctx.db
                .query("accounts")
                .withIndex("providerAndAccountId", (q) =>
                  q
                    .eq("provider", provider)
                    .eq("providerAccountId", email ?? phone!),
                )
                .unique();
              const existingUser =
                email !== undefined
                  ? await uniqueUserWithVerifiedEmail(ctx, email)
                  : await uniqueUserWithVerifiedPhone(ctx, phone!);
              const userId =
                existingUser?._id ??
                (await ctx.db.insert("users", { email, phone }));
              accountId =
                existingAccount?._id ??
                (await ctx.db.insert("accounts", {
                  userId,
                  provider,
                  providerAccountId: email ?? phone!,
                  type: "email",
                  emailVerified: false,
                  phoneVerified: false,
                }));
            }
            await generateUniqueVerificationCode(
              ctx,
              accountId,
              code,
              expirationTime,
              email !== undefined ? "email" : "phone",
            );
            return email ?? phone!;
          }
          case "createAccountFromCredentials": {
            const {
              provider: providerId,
              account,
              profile,
              shouldLink,
              emailVerified,
              phoneVerified,
            } = args;
            const provider = getProviderOrThrow(providerId);
            const existingAccount = await ctx.db
              .query("accounts")
              .withIndex("providerAndAccountId", (q) =>
                q
                  .eq("provider", provider.id)
                  .eq("providerAccountId", account.id),
              )
              .unique();
            if (existingAccount !== null && account.secret !== undefined) {
              if (
                !(await verify(
                  provider,
                  account.secret,
                  existingAccount.secret ?? "",
                ))
              ) {
                throw new Error(`Account ${account.id} already exists`);
              }
              return {
                account: existingAccount,
                user: await ctx.db.get(existingAccount.userId),
              };
            }
            let existingUserId: GenericId<"users"> | null = null;
            if (profile.email !== undefined) {
              existingUserId = shouldLink
                ? (await uniqueUserWithVerifiedEmail(ctx, profile.email))
                    ?._id ?? null
                : null;
            }
            if (profile.phone !== undefined) {
              const existingPhoneUserId = shouldLink
                ? (await uniqueUserWithVerifiedPhone(ctx, profile.email))
                    ?._id ?? null
                : null;
              if (existingPhoneUserId !== null) {
                // If there is both email and phone verified user
                // already we can't link.
                if (existingUserId !== null) {
                  existingUserId = null;
                } else {
                  existingUserId = existingPhoneUserId;
                }
              }
            }
            let userId: GenericId<"users">;
            if (existingUserId !== null) {
              await ctx.db.patch(existingUserId, profile);
              userId = existingUserId;
            } else {
              userId = await ctx.db.insert("users", profile);
            }
            const newAccountId = await ctx.db.insert("accounts", {
              userId,
              provider: providerId,
              providerAccountId: account.id,
              secret:
                account.secret !== undefined
                  ? await hash(provider, account.secret)
                  : undefined,
              type: "credentials",
              emailVerified: emailVerified === true,
              phoneVerified: phoneVerified === true,
            });
            return {
              account: await ctx.db.get(newAccountId),
              user: await ctx.db.get(userId),
            };
          }
          case "retrieveAccountWithCredentials": {
            const { provider: providerId, account } = args;
            const existingAccount = await ctx.db
              .query("accounts")
              .withIndex("providerAndAccountId", (q) =>
                q
                  .eq("provider", providerId)
                  .eq("providerAccountId", account.id),
              )
              .unique();
            if (existingAccount === null) {
              return "InvalidAccountId";
            }
            if (account.secret !== undefined) {
              if (await isSignInRateLimited(ctx, existingAccount._id, config)) {
                return "TooManyFailedAttempts";
              }
              if (
                !(await verify(
                  getProviderOrThrow(providerId),
                  account.secret,
                  existingAccount.secret ?? "",
                ))
              ) {
                await recordFailedSignIn(ctx, existingAccount._id, config);
                return "InvalidSecret";
              }
              await resetSignInRateLimit(ctx, existingAccount._id);
            }
            return {
              account: existingAccount,
              user: await ctx.db.get(existingAccount.userId),
            };
          }
          case "modifyAccount": {
            const { provider, account } = args;
            const existingAccount = await ctx.db
              .query("accounts")
              .withIndex("providerAndAccountId", (q) =>
                q.eq("provider", provider).eq("providerAccountId", account.id),
              )
              .unique();
            if (existingAccount === null) {
              throw new Error(
                `Cannot modify account with ID ${account.id} because it does not exist`,
              );
            }
            await ctx.db.patch(existingAccount._id, {
              secret: await hash(getProviderOrThrow(provider), account.secret),
            });
            return;
          }
          case "invalidateSessions": {
            const { userId, except } = args;
            const exceptSet = new Set(except ?? []);
            const sessions = await ctx.db
              .query("sessions")
              .withIndex("userId", (q) => q.eq("userId", userId))
              .collect();
            for (const session of sessions) {
              if (!exceptSet.has(session._id)) {
                await deleteSession(ctx, session);
              }
            }
            return;
          }
          default:
            args satisfies never;
        }
      },
    }),
  };
}

async function maybeGenerateTokensForSession(
  ctx: GenericMutationCtx<AuthDataModel>,
  config: ConvexAuthConfig,
  userId: GenericId<"users">,
  sessionId: GenericId<"sessions">,
  generateTokens: boolean,
) {
  return {
    userId,
    sessionId,
    tokens: generateTokens
      ? await generateTokensForSession(ctx, config, userId, sessionId)
      : null,
  };
}

async function createNewAndDeleteExistingSession(
  ctx: GenericMutationCtx<AuthDataModel>,
  config: ConvexAuthConfig,
  auth: {
    getSessionId: (ctx: {
      auth: Auth;
    }) => Promise<GenericId<"sessions"> | null>;
  },
  userId: GenericId<"users">,
) {
  const existingSessionId = await auth.getSessionId(ctx);
  if (existingSessionId !== null) {
    const existingSession = await ctx.db.get(existingSessionId);
    if (existingSession !== null) {
      await deleteSession(ctx, existingSession);
    }
  }
  return await createSession(ctx, userId, config);
}

async function generateTokensForSession(
  ctx: GenericMutationCtx<AuthDataModel>,
  config: ConvexAuthConfig,
  userId: GenericId<"users">,
  sessionId: GenericId<"sessions">,
) {
  const ids = { userId, sessionId };
  return {
    token: await generateToken(ids, config),
    refreshToken: await createRefreshToken(ctx, sessionId, config),
  };
}

async function verifyCodeOnly(
  ctx: GenericMutationCtx<AuthDataModel>,
  args: {
    code: string;
    verifier?: string;
    identifier?: string;
  },
) {
  const { code, verifier, identifier } = args;
  const codeHash = await sha256(code);
  const verificationCode = await ctx.db
    .query("authVerificationCodes")
    .withIndex("code", (q) => q.eq("code", codeHash))
    .unique();
  if (verificationCode === null) {
    console.error("Invalid verification code");
    return null;
  }
  await ctx.db.delete(verificationCode._id);
  if (verificationCode.verifier !== verifier) {
    console.error("Invalid verifier");
    return null;
  }
  if (verificationCode.expirationTime < Date.now()) {
    console.error("Expired verification code");
    return null;
  }
  const { accountId } = verificationCode;
  const account = await ctx.db.get(accountId);
  if (account === null) {
    console.error("Account associated with this email has been deleted");
    return null;
  }
  // Short code without verifier must be validated
  // via an additional identifier
  if (
    code.length < MIN_CODE_LENGTH_TO_SKIP_IDENTIFIER_CHECK &&
    verifier === undefined &&
    account.providerAccountId !== identifier
  ) {
    console.error(
      "Short verification code requires a matching `email` or `phone` " +
        "in params of `signIn`.",
    );
    return null;
  }
  const userId = account.userId;
  if (verificationCode.emailVerified) {
    if (!account.emailVerified) {
      await ctx.db.patch(accountId, { emailVerified: true });
    }
    await ctx.db.patch(userId, {
      emailVerificationTime: Date.now(),
    });
  }
  if (verificationCode.phoneVerified) {
    if (!account.phoneVerified) {
      await ctx.db.patch(accountId, { phoneVerified: true });
    }
    await ctx.db.patch(userId, {
      phoneVerificationTime: Date.now(),
    });
  }
  return { providerAccountId: account.providerAccountId, userId };
}

async function uniqueUserWithVerifiedEmail(
  ctx: GenericQueryCtx<AuthDataModel>,
  email: string,
) {
  return await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .filter((q) => q.neq(q.field("emailVerificationTime"), undefined))
    .unique();
}

async function uniqueUserWithVerifiedPhone(
  ctx: GenericQueryCtx<AuthDataModel>,
  phone: string,
) {
  return await ctx.db
    .query("users")
    .withIndex("phone", (q) => q.eq("phone", phone))
    .filter((q) => q.neq(q.field("phoneVerificationTime"), undefined))
    .unique();
}

async function verify(
  provider: AuthProviderMaterializedConfig,
  secret: string,
  hash: string,
) {
  if (provider.type !== "credentials") {
    throw new Error(`Provider ${provider.id} is not a credentials provider`);
  }
  const verify = provider.crypto?.verifySecret;
  if (verify === undefined) {
    throw new Error(
      `Provider ${provider.id} does not have a \`crypto.verifySecret\` function`,
    );
  }
  return await verify(secret, hash);
}

async function hash(provider: any, secret: string) {
  if (provider.type !== "credentials") {
    throw new Error(`Provider ${provider.id} is not a credentials provider`);
  }
  const hash = provider.crypto?.hashSecret;
  if (hash === undefined) {
    throw new Error(
      `Provider ${provider.id} does not have a \`crypto.hashSecret\` function`,
    );
  }
  return await hash(secret);
}

/**
 * Use this function from a
 * [`ConvexCredentials`](./providers/ConvexCredentials)
 * provider to create an account and a user with a unique account "id" (OAuth
 * provider ID, email address, phone number, username etc.).
 *
 * @returns user ID if it successfully creates the account
 * or throws an error.
 */
export async function createAccount<
  DataModel extends GenericDataModel = GenericDataModel,
>(
  ctx: GenericActionCtx<DataModel>,
  args: {
    /**
     * The provider ID (like "password"), used to disambiguate accounts.
     *
     * It is also used to configure account secret hashing via the provider's
     * `crypto` option.
     */
    provider: string;
    account: {
      /**
       * The unique external ID for the account, for example email address.
       */
      id: string;
      /**
       * The secret credential to store for this account, if given.
       */
      secret?: string;
    };
    /**
     * The profile data to store for the user.
     * These must fit the `users` table schema.
     */
    profile: WithoutSystemFields<DocumentByName<DataModel, "users">>;
    /**
     * If `true`, the account will be linked to an existing user
     * with the same verified email address or phone number.
     * This is only safe if the returned account is verified
     * before the user is allowed to sign in with it.
     */
    shouldLink: boolean;
    /**
     * Whether the email address ownership was already verified.
     */
    emailVerified?: boolean;
    /**
     * Whether the phone number ownership was already verified.
     */
    phoneVerified?: boolean;
  },
): Promise<{
  account: GenericDoc<DataModel, "accounts">;
  user: GenericDoc<DataModel, "users">;
}> {
  const actionCtx = ctx as unknown as GenericActionCtx<AuthDataModel>;
  return await actionCtx.runMutation(internal.auth.store, {
    args: {
      type: "createAccountFromCredentials",
      ...args,
    },
  });
}

/**
 * Use this function from a
 * [`ConvexCredentials`](./providers/ConvexCredentials)
 * provider to retrieve a user given the account provider ID and
 * the provider-specific account ID.
 *
 * @returns the retrieved user document, or `null` if there is no account
 * for given account ID or throws if the provided
 * secret does not match.
 */
export async function retrieveAccount<
  DataModel extends GenericDataModel = GenericDataModel,
>(
  ctx: GenericActionCtx<DataModel>,
  args: {
    /**
     * The provider ID (like "password"), used to disambiguate accounts.
     *
     * It is also used to configure account secret hashing via the provider's
     * `crypto` option.
     */
    provider: string;
    account: {
      /**
       * The unique external ID for the account, for example email address.
       */
      id: string;
      /**
       * The secret that should match the stored credential, if given.
       */
      secret?: string;
    };
  },
): Promise<{
  account: GenericDoc<DataModel, "accounts">;
  user: GenericDoc<DataModel, "users">;
}> {
  const actionCtx = ctx as unknown as GenericActionCtx<AuthDataModel>;
  const result = await actionCtx.runMutation(internal.auth.store, {
    args: {
      type: "retrieveAccountWithCredentials",
      ...args,
    },
  });
  if (typeof result === "string") {
    throw new Error(result);
  }
  return result;
}

/**
 * Use this function to modify the account credentials
 * from a [`ConvexCredentials`](./providers/ConvexCredentials)
 * provider.
 */
export async function modifyAccountCredentials<
  DataModel extends GenericDataModel = GenericDataModel,
>(
  ctx: GenericActionCtx<DataModel>,
  args: {
    /**
     * The provider ID (like "password"), used to disambiguate accounts.
     *
     * It is also used to configure account secret hashing via the `crypto` option.
     */
    provider: string;
    account: {
      /**
       * The unique external ID for the account, for example email address.
       */
      id: string;
      /**
       * The new secret credential to store for this account.
       */
      secret: string;
    };
  },
): Promise<GenericDoc<DataModel, "users">> {
  const actionCtx = ctx as unknown as GenericActionCtx<AuthDataModel>;
  return await actionCtx.runMutation(internal.auth.store, {
    args: {
      type: "modifyAccount",
      ...args,
    },
  });
}

/**
 * Use this function to invalidate existing sessions.
 */
export async function invalidateSessions<
  DataModel extends GenericDataModel = GenericDataModel,
>(
  ctx: GenericActionCtx<DataModel>,
  args: {
    userId: GenericId<"users">;
    except?: GenericId<"sessions">[];
  },
): Promise<GenericDoc<DataModel, "users">> {
  const actionCtx = ctx as unknown as GenericActionCtx<AuthDataModel>;
  return await actionCtx.runMutation(internal.auth.store, {
    args: {
      type: "invalidateSessions",
      ...args,
    },
  });
}

/**
 * Use this function from a
 * [`ConvexCredentials`](./providers/ConvexCredentials)
 * provider to sign in the user via another provider (usually
 * for email verification on sign up or password reset).
 *
 * Returns the user ID if the sign can proceed,
 * or `null`.
 */
export async function signInViaProvider<
  DataModel extends GenericDataModel = GenericDataModel,
>(
  ctx: GenericActionCtxWithAuthConfig<DataModel>,
  provider: AuthProviderConfig,
  args: {
    accountId?: GenericId<"accounts">;
    params?: Record<string, Value | undefined>;
  },
) {
  const result = await signInImpl(ctx, materializeProvider(provider), args, {
    generateTokens: false,
  });
  return (result.signedIn ?? null) as {
    userId: GenericId<"users">;
    sessionId: GenericId<"sessions">;
  } | null;
}

async function signInImpl(
  ctx: GenericActionCtxWithAuthConfig<AuthDataModel>,
  provider: AuthProviderMaterializedConfig | null,
  args: {
    accountId?: GenericId<"accounts">;
    params?: Record<string, any>;
    verifier?: string;
    refreshToken?: string;
  },
  options: {
    generateTokens: boolean;
  },
) {
  if (provider === null) {
    if (args.refreshToken) {
      const tokens: { token: string; refreshToken: string } =
        await ctx.runMutation(internal.auth.store, {
          args: {
            type: "refreshSession",
            refreshToken: args.refreshToken,
          },
        });
      return { signedIn: { tokens } };
    } else if (args.params?.code !== undefined) {
      const result = await ctx.runMutation(internal.auth.store, {
        args: {
          type: "verifyCodeAndSignIn",
          code: args.params.code,
          verifier: args.verifier,
          generateTokens: true,
        },
      });
      return {
        signedIn: result as {
          tokens: { token: string; refreshToken: string };
        } | null,
      };
    } else {
      throw new Error(
        "Cannot sign in: Missing `provider`, `params.code` or `refreshToken`",
      );
    }
  }
  if (provider.type === "email" || provider.type === "phone") {
    // Either code verification or NOT a sign-in to another account
    if (args.params?.code !== undefined || args.accountId === undefined) {
      if (provider.type === "email" && args.params?.email === undefined) {
        throw new Error(
          `Missing \`email\` in params for provider config ${provider.id}`,
        );
      }
      if (provider.type === "phone" && args.params?.phone === undefined) {
        throw new Error(
          `Missing \`phone\` in params for provider config ${provider.id}`,
        );
      }
    }
    if (args.params?.code !== undefined) {
      const result = await ctx.runMutation(internal.auth.store, {
        args: {
          type: "verifyCodeAndSignIn",
          code: args.params.code,
          verifier: args.verifier,
          identifier: args.params.email ?? args.params.phone!,
          generateTokens: options.generateTokens,
        },
      });
      return {
        signedIn: result as {
          userId: GenericId<"users">;
          sessionId: GenericId<"sessions">;
          tokens: {
            token: string;
            refreshToken: string;
          };
        } | null,
      };
    }

    const code = provider.generateVerificationToken
      ? await provider.generateVerificationToken()
      : generateRandomString(32, alphabet("0-9", "A-Z", "a-z"));
    const expirationTime =
      Date.now() +
      (provider.maxAge ?? DEFAULT_EMAIL_VERIFICATION_CODE_DURATION_S) * 1000;

    const identifier = (await ctx.runMutation(internal.auth.store, {
      args: {
        type: "createVerificationCode",
        provider: provider.id,
        accountId: args.accountId,
        email: args.params?.email,
        phone: args.params?.phone,
        code,
        expirationTime,
      },
    })) as string;
    const verificationArgs = {
      identifier,
      url: siteAfterLoginUrl() + "?code=" + code, // TODO should be configurable specifically for email sign in
      token: code,
      expires: new Date(expirationTime),
    };
    if (provider.type === "email") {
      await provider.sendVerificationRequest(
        {
          ...verificationArgs,
          provider: {
            ...provider,
            from:
              provider.from === "Auth.js <no-reply@authjs.dev>"
                ? "My App <onboarding@resend.dev>"
                : provider.from,
          },
          request: new Request("http://localhost"), // TODO: Document
          theme: ctx.auth.config.theme,
        },
        // @ts-expect-error Figure out typing for email providers so they can
        // access ctx.
        ctx,
      );
    } else if (provider.type === "phone") {
      await provider.sendVerificationRequest(
        { ...verificationArgs, provider },
        ctx,
      );
    }
    return { started: true };
  } else if (provider.type === "credentials") {
    const result = await (
      provider.authorize as unknown as ConvexCredentialsConfig["authorize"]
    )(args.params ?? {}, ctx);
    if (result === null) {
      return { signedIn: null };
    }
    const idsAndTokens = await ctx.runMutation(internal.auth.store, {
      args: {
        type: "signIn",
        userId: result.userId,
        sessionId: result.sessionId,
        generateTokens: options.generateTokens,
      },
    });
    return {
      signedIn: idsAndTokens as {
        userId: GenericId<"users">;
        sessionId: GenericId<"sessions">;
        tokens: {
          token: string;
          refreshToken: string;
        };
      },
    };
  } else if (provider.type === "oauth" || provider.type === "oidc") {
    // This action call is a bit of a waste, because the client will
    // immediately redirect to the signin HTTP Action.
    // But having this action call simplifies things:
    // 1. The client doesn't need to know the HTTP Actions URL
    //    of the backend (this simplifies using local backend)
    // 2. The client doesn't need to know which provider is of which type,
    //    and hence which provider requires client-side redirect
    return {
      redirect: process.env.CONVEX_SITE_URL + `/api/auth/signin/${provider.id}`,
    };
  } else {
    throw new Error(`Provider type ${provider.type} is not supported yet`);
  }
}

async function isSignInRateLimited(
  ctx: GenericMutationCtx<AuthDataModel>,
  identifier: string,
  config: ConvexAuthConfig,
) {
  const state = await getRateLimitState(ctx, identifier, config);
  if (state === null) {
    return false;
  }
  return state.attempsLeft < 1;
}

async function recordFailedSignIn(
  ctx: GenericMutationCtx<AuthDataModel>,
  identifier: string,
  config: ConvexAuthConfig,
) {
  const state = await getRateLimitState(ctx, identifier, config);
  if (state !== null) {
    await ctx.db.patch(state.limit._id, {
      attemptsLeft: state.attempsLeft - 1,
      lastAttemptTime: Date.now(),
    });
  } else {
    const maxAttempsPerHour = configuredMaxAttempsPerHour(config);
    await ctx.db.insert("authRateLimits", {
      identifier,
      attemptsLeft: maxAttempsPerHour - 1,
      lastAttemptTime: Date.now(),
    });
  }
}

async function resetSignInRateLimit(
  ctx: GenericMutationCtx<AuthDataModel>,
  identifier: string,
) {
  const existingState = await ctx.db
    .query("authRateLimits")
    .withIndex("identifier", (q) => q.eq("identifier", identifier))
    .unique();
  if (existingState !== null) {
    await ctx.db.delete(existingState._id);
  }
}

async function getRateLimitState(
  ctx: GenericMutationCtx<AuthDataModel>,
  identifier: string,
  config: ConvexAuthConfig,
) {
  const now = Date.now();
  const maxAttempsPerHour = configuredMaxAttempsPerHour(config);
  const limit = await ctx.db
    .query("authRateLimits")
    .withIndex("identifier", (q) => q.eq("identifier", identifier))
    .unique();
  if (limit === null) {
    return null;
  }
  const elapsed = now - limit.lastAttemptTime;
  const maxAttempsPerMs = maxAttempsPerHour / (60 * 60 * 1000);
  const attempsLeft = Math.min(
    maxAttempsPerHour,
    limit.attemptsLeft + elapsed * maxAttempsPerMs,
  );
  return { limit, attempsLeft };
}

function configuredMaxAttempsPerHour(config: ConvexAuthConfig) {
  return (
    config.signIn?.maxFailedAttempsPerHour ??
    DEFAULT_MAX_SIGN_IN_ATTEMPS_PER_HOUR
  );
}

async function generateUniqueVerificationCode(
  ctx: GenericMutationCtx<AuthDataModel>,
  accountId: GenericId<"accounts">,
  code: string,
  expirationTime: number,
  type: "email" | "phone",
) {
  const existingCode = await ctx.db
    .query("authVerificationCodes")
    .withIndex("accountId", (q) => q.eq("accountId", accountId))
    .unique();
  if (existingCode !== null) {
    await ctx.db.delete(existingCode._id);
  }
  await ctx.db.insert("authVerificationCodes", {
    accountId,
    code: await sha256(code),
    expirationTime,
    emailVerified: type === "email",
    phoneVerified: type === "phone",
  });
}

function clientId(providerId: string) {
  return `AUTH_${envProviderId(providerId)}_ID`;
}

function clientSecret(providerId: string) {
  return `AUTH_${envProviderId(providerId)}_SECRET`;
}

function envProviderId(provider: string) {
  return provider.toUpperCase().replace(/-/g, "_");
}

async function createSession(
  ctx: GenericMutationCtx<AuthDataModel>,
  userId: GenericId<"users">,
  config: ConvexAuthConfig,
) {
  const expirationTime =
    Date.now() +
    (config.session?.totalDurationMs ??
      stringToNumber(process.env.SESSION_TOTAL_DURATION_MS) ??
      DEFAULT_SESSION_TOTAL_DURATION_MS);
  return await ctx.db.insert("sessions", { expirationTime, userId });
}

async function deleteSession(
  ctx: GenericMutationCtx<any>,
  session: GenericDoc<AuthDataModel, "sessions">,
) {
  await ctx.db.delete(session._id);
  await deleteRefreshTokens(ctx, session._id);
}

async function createRefreshToken(
  ctx: GenericMutationCtx<any>,
  sessionId: GenericId<"sessions">,
  config: ConvexAuthConfig,
) {
  const expirationTime =
    Date.now() +
    (config.session?.inactiveDurationMs ??
      stringToNumber(process.env.SESSION_INACTIVE_DURATION_MS) ??
      DEFAULT_SESSION_INACTIVE_DURATION_MS);
  const newRefreshTokenId = await ctx.db.insert("authRefreshTokens", {
    sessionId,
    expirationTime,
  });
  return `${newRefreshTokenId}${REFRESH_TOKEN_DIVIDER}${sessionId}`;
}

async function deleteRefreshTokens(
  ctx: GenericMutationCtx<any>,
  sessionId: GenericId<"sessions">,
) {
  const existingRefreshTokens = await ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const refreshTokenDoc of existingRefreshTokens) {
    await ctx.db.delete(refreshTokenDoc._id);
  }
}

async function validateRefreshToken(
  ctx: GenericMutationCtx<AuthDataModel>,
  refreshTokenId: string,
  tokenSessionId: string,
) {
  const refreshTokenDoc = await ctx.db.get(
    refreshTokenId as GenericId<"authRefreshTokens">,
  );

  if (refreshTokenDoc === null) {
    console.error("Invalid refresh token");
    return null;
  }
  if (refreshTokenDoc.expirationTime < Date.now()) {
    console.error("Expired refresh token");
    return null;
  }
  if (refreshTokenDoc.sessionId !== tokenSessionId) {
    console.error("Invalid refresh token session ID");
    return null;
  }
  const session = await ctx.db.get(refreshTokenDoc.sessionId);
  if (session === null) {
    console.error("Invalid refresh token session");
    return null;
  }
  if (session.expirationTime < Date.now()) {
    console.error("Expired refresh token session");
    return null;
  }
  return { session, refreshTokenDoc };
}

async function generateToken(
  args: {
    userId: GenericId<any>;
    sessionId: GenericId<any>;
  },
  config: ConvexAuthConfig,
) {
  const privateKey = await importPKCS8(process.env.JWT_PRIVATE_KEY!, "RS256");
  const expirationTime = new Date(
    Date.now() + (config.jwt?.durationMs ?? DEFAULT_JWT_DURATION_MS),
  );
  return await new SignJWT({
    sub: args.userId + TOKEN_SUB_CLAIM_DIVIDER + args.sessionId,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer(process.env.CONVEX_SITE_URL!)
    .setAudience("convex")
    .setExpirationTime(expirationTime)
    .sign(privateKey);
}

function oauthStateCookieName(providerId: string) {
  return providerId + "OAuthState";
}

function corsRoutes(http: HttpRouter, origin: () => string) {
  return {
    route({
      method,
      handler,
      credentials,
      ...paths
    }: {
      method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
      handler: PublicHttpAction;
      credentials: boolean;
    } & ({ path: string } | { pathPrefix: string })) {
      if (method !== "GET") {
        http.route({
          ...paths,
          method: "OPTIONS",
          handler: httpActionGeneric(async () => {
            const headers = new Headers();
            headers.set("Access-Control-Allow-Origin", origin());
            headers.set("Access-Control-Allow-Methods", method);
            headers.set("Access-Control-Allow-Headers", "Content-Type, Digest");
            headers.set("Vary", "Origin");
            if (credentials) {
              headers.set("Access-Control-Allow-Credentials", "true");
            }

            return new Response(null, { status: 200, headers: headers });
          }),
        });
      }

      http.route({
        ...paths,
        method,
        handler: httpActionGeneric(async (ctx, req) => {
          const response = await (handler as any)(ctx, req);
          const headers = new Headers(response.headers);
          headers.set("Access-Control-Allow-Origin", origin());
          if (credentials) {
            headers.set("Access-Control-Allow-Credentials", "true");
          }

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: headers,
          });
        }),
      });
    },
  };
}

function convertErrorsToResponse(
  errorStatusCode: number,
  action: (ctx: GenericActionCtx<any>, request: Request) => Promise<Response>,
) {
  return async (ctx: GenericActionCtx<any>, request: Request) => {
    try {
      return await action(ctx, request);
    } catch (error) {
      if (error instanceof ConvexError) {
        return new Response(null, {
          status: errorStatusCode,
          statusText: (error as any).data,
        });
      } else {
        console.error((error as Error).message ?? error);
        return new Response(null, {
          status: 500,
          statusText: "Internal Server Error",
        });
      }
    }
  };
}

function getCookies(req: Request): Record<string, string | undefined> {
  return cookie.parse(req.headers.get("Cookie") ?? "");
}

function siteAfterLoginUrl() {
  return process.env.SITE_AFTER_LOGIN_URL ?? siteUrl();
}

function siteUrl() {
  if (process.env.SITE_URL === undefined) {
    throw new Error("Missing `SITE_URL` environment variable");
  }
  return process.env.SITE_URL;
}

async function sha256(input: string) {
  return encodeHex(await rawSha256(new TextEncoder().encode(input)));
}

function stringToNumber(value: string | undefined) {
  return value !== undefined ? Number(value) : undefined;
}
