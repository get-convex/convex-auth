import {
  Provider as AuthProvider,
  OAuth2Config,
  OAuthConfig,
} from "@auth/core/providers";
import { TokenSet } from "@auth/core/types";
import { generateState } from "arctic";
import {
  DataModelFromSchemaDefinition,
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  HttpRouter,
  PublicHttpAction,
  actionGeneric,
  defineSchema,
  defineTable,
  httpActionGeneric,
  internalMutationGeneric,
} from "convex/server";
import { ConvexError, GenericId, ObjectType, v } from "convex/values";
import * as cookie from "cookie";
import { SignJWT, importPKCS8 } from "jose";
import {
  alphabet,
  generateRandomString,
  sha256 as rawSha256,
} from "oslo/crypto";
import { encodeHex } from "oslo/encoding";
import { OAuth2Client } from "oslo/oauth2";
import { FunctionReferenceFromExport, GenericDoc } from "./convex_types";
import {
  MaterializedProvider,
  configDefaults,
  getOAuthURLs,
  materializeProvider,
} from "./provider_utils";
import { ConvexAuthConfig, GenericActionCtxWithAuthConfig } from "./types";

const DEFAULT_EMAIL_VERIFICATION_CODE_DURATION_MS = 1000 * 60 * 60 * 24; // 24 hours
const DEFAULT_SESSION_TOTAL_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const DEFAULT_SESSION_INACTIVE_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const DEFAULT_JWT_DURATION_MS = 1000 * 60 * 60; // 1 hour
const OAUTH_SIGN_IN_EXPIRATION_MS = 1000 * 60 * 2; // 2 minutes
const REFRESH_TOKEN_DIVIDER = "|";
const TOKEN_SUB_CLAIM_DIVIDER = "|";

export const tables = {
  users: defineTable({
    email: v.string(),
    emailVerified: v.optional(v.boolean()),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
  }).index("email", ["email"]),
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
  })
    .index("providerAndUserId", ["provider", "userId"])
    .index("providerAndAccountId", ["provider", "providerAccountId"]),
  verifiers: defineTable({
    state: v.string(),
    verifier: v.string(),
  }).index("state", ["state"]),
  verificationCodes: defineTable({
    userId: v.id("users"),
    code: v.string(),
    expirationTime: v.number(),
    verifier: v.optional(v.string()),
    emailVerified: v.optional(v.boolean()),
  })
    .index("userId", ["userId"])
    .index("code", ["code"]),
  sessions: defineTable({
    userId: v.id("users"),
    expirationTime: v.number(),
  }).index("userId", ["userId"]),
  refreshTokens: defineTable({
    userId: v.id("users"),
    sessionId: v.id("sessions"),
    expirationTime: v.number(),
  }).index("sessionId", ["sessionId"]),
};

const defaultSchema = defineSchema(tables);

export type AuthDataModel = DataModelFromSchemaDefinition<typeof defaultSchema>;

const storeArgs = {
  args: v.union(
    v.object({
      type: v.literal("signIn"),
      userId: v.id("users"),
    }),
    v.object({
      type: v.literal("signOut"),
    }),
    v.object({
      type: v.literal("verifyCode"),
      code: v.optional(v.string()),
      refreshToken: v.optional(v.string()),
      verifier: v.optional(v.string()),
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
      type: v.literal("emailVerificationCode"),
      userId: v.id("users"),
      code: v.string(),
      expirationTime: v.number(),
    }),
    v.object({
      type: v.literal("userAndEmailVerificationCode"),
      email: v.string(),
      code: v.string(),
      expirationTime: v.number(),
    }),
    v.object({
      type: v.literal("createAccount"),
      provider: v.string(),
      account: v.object({ id: v.string(), secret: v.string() }),
      profile: v.any(),
    }),
    v.object({
      type: v.literal("retrieveAccountAndCheckSecret"),
      provider: v.string(),
      account: v.object({ id: v.string(), secret: v.string() }),
    }),
    v.object({
      type: v.literal("retrieveAccount"),
      provider: v.string(),
      account: v.object({ id: v.string() }),
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

export type SignInAction = FunctionReferenceFromExport<
  ReturnType<typeof convexAuth>["signIn"]
>;
export type VerifyCodeAction = FunctionReferenceFromExport<
  ReturnType<typeof convexAuth>["verifyCode"]
>;
export type SignOutAction = FunctionReferenceFromExport<
  ReturnType<typeof convexAuth>["signOut"]
>;

export function convexAuth(rawConfig: ConvexAuthConfig) {
  const config = configDefaults(rawConfig);
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
    getUserId: async (ctx: GenericQueryCtx<any>) => {
      const identity = await ctx.auth.getUserIdentity();
      if (identity === null) {
        return null;
      }
      const [userId] = identity.subject.split(TOKEN_SUB_CLAIM_DIVIDER);
      return userId as GenericId<"users">;
    },
    getSessionId: async (ctx: GenericQueryCtx<any>) => {
      const identity = await ctx.auth.getUserIdentity();
      if (identity === null) {
        return null;
      }
      const [, sessionId] = identity.subject.split(TOKEN_SUB_CLAIM_DIVIDER);
      return sessionId as GenericId<"sessions">;
    },
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
            const provider = getProviderOrThrow(providerId) as OAuthConfig<any>;
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
          const provider = getProviderOrThrow(providerId) as OAuth2Config<any>;

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
            const client = new OAuth2Client(provider.clientId, "", token.url, {
              redirectURI:
                process.env.CONVEX_SITE_URL +
                "/api/auth/callback/" +
                providerId,
            });
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
            destinationUrl.searchParams.set("code", verificationCode as string);
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
    },
  };
  return {
    auth,
    signIn: actionGeneric({
      args: {
        provider: v.string(),
        params: v.any(),
      },
      handler: async (ctx, args) => {
        const provider = getProviderOrThrow(args.provider);
        return await signInImpl(enrichCtx(ctx), provider, args.params);
      },
    }),

    verifyCode: actionGeneric({
      args: {
        provider: v.optional(v.string()),
        params: v.any(),
        refreshToken: v.optional(v.string()),
        verifier: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        const provider = args.provider ? getProvider(args.provider) : undefined;
        const result = await ctx.runMutation(internal.auth.store, {
          args: {
            type: "verifyCode",
            code: args.params.code,
            refreshToken: args.refreshToken,
            verifier: args.verifier,
          },
        });
        if (result === null) {
          return null;
        }
        const { userId, sessionId, token, refreshToken } = result;
        if (provider !== undefined && "afterCodeVerification" in provider) {
          const providerAccountId = await ctx.runMutation(internal.auth.store, {
            args: {
              type: "getProviderAccountId",
              provider: provider.id,
              userId,
            },
          });
          (provider.afterCodeVerification as any)(
            args.params,
            { userId, providerAccountId, sessionId },
            enrichCtx(ctx),
          );
        }
        return { token, refreshToken };
      },
    }),

    signOut: actionGeneric({
      args: {},
      handler: async (ctx) => {
        await ctx.runMutation(internal.auth.store, {
          args: { type: "signOut" },
        });
      },
    }),

    store: internalMutationGeneric({
      args: storeArgs,
      handler: async (ctx: GenericMutationCtx<AuthDataModel>, { args }) => {
        switch (args.type) {
          case "signIn": {
            const { userId } = args;
            const sessionId = await createSession(ctx, userId, config);
            const ids = { userId, sessionId };
            return {
              token: await generateToken(ids, config),
              refreshToken: await createRefreshToken(ctx, ids, config),
            };
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
          case "verifyCode": {
            const { code, verifier, refreshToken } = args;
            if (refreshToken !== undefined) {
              const [refreshTokenId, tokenSessionId] = refreshToken.split(
                REFRESH_TOKEN_DIVIDER,
              );
              const refreshTokenDoc = await validateRefreshToken(
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

              if (refreshTokenDoc === null) {
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
              const { userId, sessionId } = refreshTokenDoc;
              const ids = { userId, sessionId };
              return {
                token: await generateToken(ids, config),
                sessionId,
                userId,
                refreshToken: await createRefreshToken(ctx, ids, config),
              };
            } else {
              if (code === undefined) {
                console.error("Missing `code` in params of `verifyCode`");
                return null;
              }
              const codeHash = await sha256(code);
              const verificationCode = await ctx.db
                .query("verificationCodes")
                .withIndex("code", (q) => q.eq("code", codeHash))
                .unique();
              if (verificationCode === null) {
                throw new ConvexError("Invalid verification code");
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
              const { userId } = verificationCode;
              if (verificationCode.emailVerified) {
                const user = (await ctx.db.get(userId))!;
                if (user.emailVerified !== true) {
                  await ctx.db.patch(userId, { emailVerified: true });
                }
              }
              const sessionId = await createSession(ctx, userId, config);
              const ids = { userId, sessionId };
              return {
                token: await generateToken(ids, config),
                sessionId,
                userId,
                refreshToken: await createRefreshToken(ctx, ids, config),
              };
            }
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
            return await ctx.db.insert("verifiers", { verifier, state });
          }
          // TODO: Allow auto-linking for email-verified OAuth providers
          case "userOAuth": {
            const { profile, provider, providerAccountId, state } = args;

            const existingAccount = await ctx.db
              .query("accounts")
              .withIndex("providerAndAccountId", (q) =>
                q
                  .eq("provider", provider)
                  .eq("providerAccountId", providerAccountId),
              )
              .unique();

            let userId: GenericId<"users">;
            if (existingAccount !== null) {
              userId = existingAccount.userId;
            } else {
              // TODO: Allow auto-linking for email-verified OAuth providers
              userId = await ctx.db.insert("users", profile);
              await ctx.db.insert("accounts", {
                userId,
                provider,
                providerAccountId,
                type: "oauth",
              });
            }

            const verifier = await ctx.db
              .query("verifiers")
              .withIndex("state", (q) => q.eq("state", state))
              .unique();
            if (verifier === null) {
              throw new Error("Invalid state");
            }
            const code = generateRandomString(8, alphabet("0-9"));
            await ctx.db.delete(verifier._id);
            const existingVerificationCode = await ctx.db
              .query("verificationCodes")
              .withIndex("userId", (q) => q.eq("userId", userId))
              .unique();
            if (existingVerificationCode !== null) {
              await ctx.db.delete(existingVerificationCode._id);
            }
            await ctx.db.insert("verificationCodes", {
              code: await sha256(code),
              userId,
              expirationTime: Date.now() + OAUTH_SIGN_IN_EXPIRATION_MS,
              verifier: verifier?.verifier,
              // TODO: Allow configuring OAuth providers as email-verified,
              // GitHub is always for example.
            });
            return code;
          }
          case "emailVerificationCode": {
            const { userId, code, expirationTime } = args;
            const existingUser = await ctx.db.get(userId);
            if (existingUser === null) {
              throw new Error(`Expected a user to exist for ID "${userId}"`);
            }
            await generateUniqueEmailVerificationCode(
              ctx,
              userId,
              code,
              expirationTime,
            );
            return existingUser.email;
          }
          case "userAndEmailVerificationCode": {
            const { email, code, expirationTime } = args;
            const existingUser = await ctx.db
              .query("users")
              .withIndex("email", (q) => q.eq("email", email))
              .unique();
            const userId =
              existingUser?._id ?? (await ctx.db.insert("users", { email }));
            await generateUniqueEmailVerificationCode(
              ctx,
              userId,
              code,
              expirationTime,
            );
            return email;
          }
          case "createAccount": {
            const { provider, account, profile } = args;
            const existingAccount = await ctx.db
              .query("accounts")
              .withIndex("providerAndAccountId", (q) =>
                q.eq("provider", provider).eq("providerAccountId", account.id),
              )
              .unique();
            const { hash, verify } = getHashAndVerifyFns(
              getProviderOrThrow(provider),
            );
            if (existingAccount !== null) {
              if (
                !(await verify(account.secret, existingAccount.secret ?? ""))
              ) {
                throw new Error(`Account ${account.id} already exists`);
              }
              return await ctx.db.get(existingAccount.userId);
            }
            // TODO: Auto-linking
            const userId = await ctx.db.insert("users", profile);
            await ctx.db.insert("accounts", {
              userId,
              provider,
              providerAccountId: account.id,
              secret: await hash(account.secret),
              type: "credentials",
            });
            return await ctx.db.get(userId);
          }
          case "retrieveAccountAndCheckSecret": {
            const { provider, account } = args;
            const existingAccount = await ctx.db
              .query("accounts")
              .withIndex("providerAndAccountId", (q) =>
                q.eq("provider", provider).eq("providerAccountId", account.id),
              )
              .unique();
            if (existingAccount === null) {
              return null;
            }
            const { verify } = getHashAndVerifyFns(
              getProviderOrThrow(provider),
            );
            if (!(await verify(account.secret, existingAccount.secret ?? ""))) {
              throw new Error("Invalid secret");
            }
            return await ctx.db.get(existingAccount.userId);
          }
          case "retrieveAccount": {
            const { provider, account } = args;
            const existingAccount = await ctx.db
              .query("accounts")
              .withIndex("providerAndAccountId", (q) =>
                q.eq("provider", provider).eq("providerAccountId", account.id),
              )
              .unique();
            if (existingAccount === null) {
              return null;
            }
            return await ctx.db.get(existingAccount.userId);
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
            const { hash } = getHashAndVerifyFns(getProviderOrThrow(provider));
            await ctx.db.patch(existingAccount._id, {
              secret: await hash(account.secret),
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

function getHashAndVerifyFns(provider: any) {
  const hash = provider.crypto.hashSecret;
  const verify = provider.crypto.verifySecret;
  if (hash === undefined) {
    throw new Error(
      `Provider ${provider} does not have a \`crypto.verifySecret\` function`,
    );
  }
  if (verify === undefined) {
    throw new Error(
      `Provider ${provider} does not have a \`crypto.verifySecret\` function`,
    );
  }
  return { hash, verify } as {
    hash: (secret: string) => Promise<string>;
    verify: (secret: string, hash: string) => Promise<boolean>;
  };
}

/**
 * In some places, such as the `sendVerificationRequest` method
 * of Email providers, we pass the Convex ctx as the current Request.
 * Use this function to get the correct type.
 */
export function requestToCtx<DataModel extends AuthDataModel = AuthDataModel>(
  request: Request,
): GenericActionCtx<DataModel> {
  return request as any;
}

/**
 * Use this function from a `ConvexCredentials` provider
 * to create an account and a user with a pair of unique
 * id and an account secret.
 *
 * @returns user ID if it successfully creates the account
 * or throws an error.
 */
export async function createAccountWithCredentials<
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
       * The secret credential to store for this account.
       */
      secret: string;
    };
    /**
     * The profile data to store for the user.
     * These must fit the `users` table schema.
     */
    profile: { email: string } & Record<string, any>;
  },
): Promise<GenericDoc<DataModel, "users">> {
  const actionCtx = ctx as unknown as GenericActionCtx<AuthDataModel>;
  return await actionCtx.runMutation(internal.auth.store, {
    args: {
      type: "createAccount",
      ...args,
    },
  });
}

/**
 * Use this function from a `ConvexCredentials` provider
 * to retrieve a user given a pair of unique account
 * id and an account secret.
 *
 * @returns the retrieved user document, or `null` if there is no account
 * for given account ID, or throws if the provided
 * secret does not match.
 */
export async function retrieveAccountWithCredentials<
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
       * The secret that should match the stored credential.
       */
      secret: string;
    };
  },
): Promise<GenericDoc<DataModel, "users">> {
  const actionCtx = ctx as unknown as GenericActionCtx<AuthDataModel>;
  return await actionCtx.runMutation(internal.auth.store, {
    args: {
      type: "retrieveAccountAndCheckSecret",
      ...args,
    },
  });
}

/**
 * Use this function from a `ConvexCredentials` provider
 * to retrieve a user given the account provider ID and
 * the provider-specific account ID.
 *
 * @returns the retrieved user document, or `null` if there is no account
 * for given account ID.
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
    };
  },
): Promise<GenericDoc<DataModel, "users">> {
  const actionCtx = ctx as unknown as GenericActionCtx<AuthDataModel>;
  console.log(args);

  return await actionCtx.runMutation(internal.auth.store, {
    args: {
      type: "retrieveAccount",
      ...args,
    },
  });
}

/**
 * Use this function to modify the account credentials
 * from a `ConvexCredentials` provider.
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
 * Use this function from a `ConvexCredentials` provider
 * to sign in the user via another provider (usually
 * for email verification on sign up or password reset).
 */
export async function signInViaProvider<
  DataModel extends GenericDataModel = GenericDataModel,
>(
  ctx: GenericActionCtxWithAuthConfig<DataModel>,
  provider: AuthProvider,
  signedIn: { userId: GenericId<"users"> },
) {
  await signInImpl(ctx, materializeProvider(provider), {}, signedIn);
  return null;
}

async function signInImpl(
  ctx: GenericActionCtxWithAuthConfig<AuthDataModel>,
  provider: MaterializedProvider,
  params: any,
  signedIn?: { userId: GenericId<"users"> },
) {
  if (provider.type === "email") {
    const code = provider.generateVerificationToken
      ? await provider.generateVerificationToken()
      : generateRandomString(32, alphabet("0-9", "A-Z", "a-z"));
    const expirationTime =
      Date.now() +
      (provider.maxAge ?? DEFAULT_EMAIL_VERIFICATION_CODE_DURATION_MS);
    const email = (await ctx.runMutation(internal.auth.store, {
      args:
        signedIn !== undefined
          ? {
              type: "emailVerificationCode",
              userId: signedIn.userId,
              code,
              expirationTime,
            }
          : {
              type: "userAndEmailVerificationCode",
              email: params.email,
              code,
              expirationTime,
            },
    })) as string;
    await provider.sendVerificationRequest({
      identifier: email,
      url: siteAfterLoginUrl() + "?code=" + code, // TODO should be configurable specifically for email sign in
      expires: new Date(), // TODO
      provider: {
        ...provider,
        from:
          provider.from === "Auth.js <no-reply@authjs.dev>"
            ? "My App <onboarding@resend.dev>"
            : provider.from,
      },
      request: new Request("http://localhost"), // TODO: Document
      theme: ctx.auth.config.theme!,
      token: code,
    });
    return { started: true };
  } else if (provider.type === "credentials") {
    const user = await provider.authorize(params, ctx as any);
    if (user === null) {
      return { tokens: null };
    }
    const tokens = await ctx.runMutation(internal.auth.store, {
      args: {
        type: "signIn",
        userId: user.id as any,
      },
    });
    return { tokens };
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

async function generateUniqueEmailVerificationCode(
  ctx: GenericMutationCtx<AuthDataModel>,
  userId: GenericId<"users">,
  code: string,
  expirationTime: number,
) {
  const existingCode = await ctx.db
    .query("verificationCodes")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .unique();
  if (existingCode !== null) {
    await ctx.db.delete(existingCode._id);
  }
  await ctx.db.insert("verificationCodes", {
    userId,
    code: await sha256(code),
    expirationTime,
    emailVerified: true,
  });
}

function clientId(providerId: string) {
  return `AUTH_${providerId}_ID`;
}

function clientSecret(providerId: string) {
  return `AUTH_${providerId}_SECRET`;
}

async function createSession(
  ctx: GenericMutationCtx<any>,
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
  {
    userId,
    sessionId,
  }: {
    userId: GenericId<"users">;
    sessionId: GenericId<"sessions">;
  },
  config: ConvexAuthConfig,
) {
  const expirationTime =
    Date.now() +
    (config.session?.inactiveDurationMs ??
      stringToNumber(process.env.SESSION_INACTIVE_DURATION_MS) ??
      DEFAULT_SESSION_INACTIVE_DURATION_MS);
  const newRefreshTokenId = await ctx.db.insert("refreshTokens", {
    userId,
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
    .query("refreshTokens")
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
    refreshTokenId as GenericId<"refreshTokens">,
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
  return refreshTokenDoc;
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

export function convertErrorsToResponse(
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
        return new Response(null, {
          status: 500,
          statusText: "Internal Server Error",
        });
      }
    }
  };
}

export function getCookies(req: Request): Record<string, string | undefined> {
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
