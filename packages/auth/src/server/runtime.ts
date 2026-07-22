import {
  GenericActionCtx,
  GenericDataModel,
  HttpRouter,
  actionGeneric,
  httpRouter,
  internalMutationGeneric,
} from "convex/server";
import { v } from "convex/values";

import type { AuthTokens, SignInFlowResult } from "../shared/results";
import { createCoreDomains } from "./core";
import { GetProviderOrThrowFunc } from "./crypto";
import { requireEnv } from "./env";
import { createAuthEventDomain, emitAuthEvent } from "./events";
import {
  addAuthRoutes,
  addOAuthProviderRoutes,
  addOpenIdRoutes,
  addWellKnownRoutes,
  createHttpAction,
  createHttpContext,
  createHttpRoute,
} from "./http";
import { addMcpRoutes, type McpToolDef } from "./mcp";
import { createAuthorizeHandler } from "./oauth/authorize";
import { createOAuthHttpHandlers } from "./oauth/handlers";
import { createClientManagementHandler } from "./oauth/manage";
import { createRegisterHandler } from "./oauth/register";
import { createTokenHandler } from "./oauth/token";
import { verifyOAuthToken } from "./tokens";
import { wellKnown } from "./wellknown";
import { log } from "./log";
import {
  callCreateAccountFromCredentials,
  callInvalidateSessions,
  callModifyAccount,
  callRetrieveAccountWithCredentials,
  callSignOut,
  callUserOAuth,
  callVerifierSignature,
  vStoreArgs,
  storeImpl,
} from "./mutations/calls";
import { vPayloadRecord } from "./payloads";
import { generateRandomString, INVITE_TOKEN_ALPHABET, sha256 } from "./random";
import { extractBearerToken } from "./utils/bearer";
import { encryptSecret } from "./secret";
import { createGroupService } from "./connection/group/service";
import { createFactorUnlinkHelpers } from "./services/factors";
import { resolveServerServices } from "./services/resolve";
import { signInImpl } from "./signin/flow";
import { createGroupConnectionDomain } from "./connection/domain";
import { addGroupHttpRuntime } from "./connection/http";
import { normalizeGroupConnectionPolicy } from "./connection/policy";
import type {
  ConvexAuthConfig,
  FunctionReferenceFromExport,
  ConnectionProviderConfig,
} from "./types";
import { MutationCtx } from "./types";
import { appUrlFromEnv, authUrlFromEnv } from "./url";

const GROUP_CONNECTION_OIDC_CLIENT_SECRET_KIND = "oidc_client_secret" as const;

/**
 * Single sanctioned bridge across an irreducible cross-package ctx/domain
 * family boundary. Several runtime values are structurally equivalent at
 * runtime to a consumer's nominal type but cannot be positively unified by
 * TypeScript — e.g. the {@link enrichCtx}-enriched action ctx versus the
 * sign-in service's `GenericActionCtxWithAuthConfig`, or the assembled
 * `authBase` versus the HTTP context's `HttpContextAuthLike`. This is the one
 * narrow, typed assertion those boundaries route through; callers name the
 * exact target via the `T` type argument so the result stays precisely typed.
 */
function bridgeRuntimeType<T>(value: object): T {
  return value as T;
}

/**
 * Preserve Convex action context behavior while replacing `ctx.auth`.
 *
 * Convex context methods can be non-enumerable or prototype-backed. A plain
 * `{ ...ctx, auth }` drops those methods in packaged builds, so calls such as
 * `ctx.runQuery(...)` disappear inside provider flows. Forward the call methods
 * bound to the original ctx and preserve the rest of the context descriptors.
 *
 * @internal
 */
export function enrichActionCtx<
  DataModel extends GenericDataModel,
  AuthContext extends GenericActionCtx<DataModel>["auth"] & Record<string, unknown>,
>(
  ctx: GenericActionCtx<DataModel>,
  auth: AuthContext,
): GenericActionCtx<DataModel> & { auth: AuthContext } {
  const {
    auth: _authDescriptor,
    runAction: _runActionDescriptor,
    runMutation: _runMutationDescriptor,
    runQuery: _runQueryDescriptor,
    ...descriptors
  } = Object.getOwnPropertyDescriptors(ctx);

  const enriched = Object.create(
    Object.getPrototypeOf(ctx),
    descriptors,
  ) as GenericActionCtx<DataModel>;

  Object.defineProperties(enriched, {
    auth: {
      configurable: true,
      enumerable: true,
      value: auth,
      writable: true,
    },
    runAction: {
      configurable: true,
      value: ctx.runAction.bind(ctx),
      writable: true,
    },
    runMutation: {
      configurable: true,
      value: ctx.runMutation.bind(ctx),
      writable: true,
    },
    runQuery: {
      configurable: true,
      value: ctx.runQuery.bind(ctx),
      writable: true,
    },
  });

  return enriched as GenericActionCtx<DataModel> & { auth: AuthContext };
}

/**
 * The type of the signIn Convex Action returned from the auth() helper.
 *
 * This type is exported for implementors of other client integrations.
 * However it is not stable, and may change until this library reaches 1.0.
 *
 * @internal
 */
export type SignInAction = FunctionReferenceFromExport<ReturnType<typeof Auth>["signIn"]>;

/** @internal */
export type SignInActionResult = SignInFlowResult<AuthTokens | null>;
/**
 * The type of the signOut Convex Action returned from the auth() helper.
 *
 * This type is exported for implementors of other client integrations.
 * However it is not stable, and may change until this library reaches 1.0.
 *
 * @internal
 */
export type SignOutAction = FunctionReferenceFromExport<ReturnType<typeof Auth>["signOut"]>;

/**
 * Configure the Convex Auth library. Returns an object with
 * functions and `auth` helper. You must export the functions
 * from `convex/auth.ts` to make them callable:
 *
 * ```ts filename="convex/auth.ts"
 * import { defineAuth } from "@robelest/convex-auth/component";
 * import { components } from "./_generated/api";
 *
 * export const auth = defineAuth(components.auth, {
 *   providers: [],
 * });
 * export const { signIn, signOut, store } = auth;
 * ```
 *
 * Mount the auth HTTP routes from `convex/http.ts`:
 *
 * ```ts filename="convex/http.ts"
 * import { auth } from "./auth";
 *
 * export default auth.http();
 * ```
 *
 * @returns An object with fields you should reexport from your
 *          `convex/auth.ts` file, plus the `http` router factory.
 */
export function Auth(config_: ConvexAuthConfig) {
  const services = resolveServerServices(config_);
  const config = services.config;
  const delegatableGrants: string[] = [...(config.permissions?.grants ?? [])];
  const hasOAuth = config.providers.some((provider) => provider.type === "oauth");
  const hasConnection = config.providers.some((provider) => provider.type === "connection");
  const ssoProvider = config.providers.find(
    (provider): provider is ConnectionProviderConfig => provider.type === "connection",
  );
  const getProviderOrThrow: GetProviderOrThrowFunc = services.providerRegistry.getProviderOrThrow;
  const INVITE_TOKEN_LENGTH = 48;

  const GROUP_CONNECTION_ROUTE_BASE = "/connections";
  const routePrefix = config.path ?? "/auth";
  const authSiteUrl = () => authUrlFromEnv(routePrefix);
  const authCallbackUrl = (providerId: string) => `${authSiteUrl()}/callback/${providerId}`;
  const group = createGroupService({ config, sha256 });
  const authRequireEnv = (name: string) =>
    name === "CONVEX_SITE_URL" ? authSiteUrl() : requireEnv(name);

  type AuthRuntimeBase = ReturnType<typeof createCoreDomains> & {
    event: ReturnType<typeof createAuthEventDomain>;
    connection: ReturnType<typeof createGroupConnectionDomain>;
  };

  const authBase: AuthRuntimeBase = {
    ...createCoreDomains({
      config,
      callInvalidateSessions,
      callCreateAccountFromCredentials,
      callRetrieveAccountWithCredentials,
      callModifyAccount,
      getEnrichCtx: () => enrichCtx,
      inviteTokenAlphabet: INVITE_TOKEN_ALPHABET,
      inviteTokenLength: INVITE_TOKEN_LENGTH,
      signInForProvider: async (ctx, providerConfig, args) => {
        const materialized =
          typeof providerConfig === "function" ? providerConfig() : providerConfig;
        const result = await signInImpl(
          bridgeRuntimeType<Parameters<typeof signInImpl>[0]>(enrichCtx(ctx)),
          materialized as Parameters<typeof signInImpl>[1],
          args,
          {
            generateTokens: false,
            allowExtraProviders: true,
          },
        );
        if (result.kind === "signedIn") {
          const session = result.session as {
            userId?: string;
            sessionId?: string;
            _id?: string;
          } | null;
          if (session === null || session === undefined) {
            return null;
          }
          const userId = session.userId;
          const sessionId = session.sessionId ?? session._id;
          if (userId === undefined || sessionId === undefined) {
            return null;
          }
          return { userId, sessionId };
        }
        return result as Exclude<typeof result, { kind: "signedIn" }>;
      },
    }),
    event: createAuthEventDomain(config),
    /**
     * Connection namespace — group connection management, domain, OIDC,
     * SAML, SCIM, audit, and webhook helpers.
     */
    connection: createGroupConnectionDomain({
      config,
      getGroupConnectionSecret: group.getGroupConnectionSecret,
      loadConnectionOrThrow: group.loadConnectionOrThrow,
      validateGroupConnectionPolicy: group.validateGroupConnectionPolicy,
      emitGroupAuthEvent: group.emitGroupAuthEvent,
      connectionNotFoundError: "Connection not found.",
      GROUP_CONNECTION_OIDC_CLIENT_SECRET_KIND,
      requireEnv: authRequireEnv,
      generateRandomString,
      INVITE_TOKEN_ALPHABET,
      sha256,
      encryptSecret,
      loadGroupPolicyOrThrow: group.loadGroupPolicyOrThrow,
    }),
  };

  const getDefaultCorsOrigins = () => [new URL(appUrlFromEnv()).origin];

  const getAuthSiteUrl = (_ctx: GenericActionCtx<GenericDataModel>) => authSiteUrl();

  const oauthHttpHandlers = createOAuthHttpHandlers({
    config,
    getProviderOrThrow,
    authCallbackUrl,
  });

  const request = {
    /**
     * Register core HTTP routes for JWT verification and OAuth sign-in.
     *
     * ```ts
     * import { httpRouter } from "convex/server";
     * import { auth } from "./auth";
     *
     * export default auth.http();
     * ```
     *
     * The following routes are handled always:
     *
     * - `/.well-known/apple-app-site-association`
     * - `/.well-known/assetlinks.json`
     * - `/.well-known/webauthn`
     * - `/.well-known/change-password`
     * - `/.well-known/security.txt`
     * - `<prefix>/.well-known/openid-configuration`
     * - `<prefix>/.well-known/jwks.json`
     *
     * The following routes are handled if OAuth is configured:
     *
     * - `/signin/*`
     * - `/callback/*`
     *
     * @param http your HTTP router
     */
    add: (http: HttpRouter) => {
      const protocolRequireEnv = (name: string) =>
        name === "CONVEX_SITE_URL" ? authSiteUrl() : requireEnv(name);

      addOpenIdRoutes(http, {
        routeBase: routePrefix,
        getIssuer: authSiteUrl,
        getJwks: () => requireEnv("JWKS"),
        oauth: config.oauth ? { scopes: delegatableGrants } : undefined,
      });

      addWellKnownRoutes(http, {
        getResponse: (endpoint) => wellKnown(endpoint),
      });

      addGroupHttpRuntime({
        http,
        hasConnection,
        auth: authBase as Parameters<typeof addGroupHttpRuntime>[0]["auth"],
        config,
        routeBase: `${routePrefix}${GROUP_CONNECTION_ROUTE_BASE}`,
        requireEnv: protocolRequireEnv,
        loadActiveConnectionSamlOrThrow: group.loadActiveConnectionSamlOrThrow,
        loadConnectionOidcOrThrow: group.loadConnectionOidcOrThrow,
        getGroupConnectionScimContext: group.getGroupConnectionScimContext,
        loadGroupPolicyOrThrow: group.loadGroupPolicyOrThrow,
        normalizeGroupConnectionPolicy,
        emitGroupAuthEvent: group.emitGroupAuthEvent,
        generateRandomString,
        inviteTokenAlphabet: INVITE_TOKEN_ALPHABET,
        callUserOAuth,
        callVerifierSignature,
        sharedOidcRedirectURI: ssoProvider?.redirectURI,
      });

      if (config.oauth) {
        addOAuthProviderRoutes(http, {
          routeBase: routePrefix,
          handleAuthorize: createAuthorizeHandler({
            getClient: (ctx, clientId) => authBase.oauth.client.get(ctx, { clientId }),
            consentPage: config.oauth.pages.consent,
            authSiteUrl,
          }),
          handleToken: createTokenHandler({
            issuer: authSiteUrl,
            getClient: (ctx, clientId) => authBase.oauth.client.get(ctx, { clientId }),
            verifyClientSecret: (ctx, clientId, clientSecret) =>
              authBase.oauth.client.verify(ctx, { clientId, clientSecret }),
            acceptCode: (ctx, codeHash, clientId, redirectUri, codeChallenge, refresh) =>
              authBase.oauth.code.accept(ctx, {
                codeHash,
                clientId,
                redirectUri,
                codeChallenge,
                refresh,
              }),
            mintRefresh: () => authBase.oauth.refresh.mint(),
            exchangeRefresh: (ctx, args) => authBase.oauth.refresh.exchange(ctx, args),
            emitEvent: async (ctx, event) => await emitAuthEvent(ctx, config, event),
          }),
          handleRegister: createRegisterHandler({
            createClient: (ctx, opts) =>
              authBase.oauth.client.create(ctx, { data: { ...opts, extend: { kind: "dcr" } } }),
            allowedScopes: delegatableGrants,
            registrationClientUri: (clientId) => `${authSiteUrl()}/oauth2/register/${clientId}`,
          }),
          handleManage: createClientManagementHandler({
            verifyRegistrationToken: (ctx, args) =>
              authBase.oauth.client.verifyRegistrationToken(ctx, args),
            update: (ctx, args) => authBase.oauth.client.update(ctx, args),
            revoke: (ctx, args) => authBase.oauth.client.revoke(ctx, args),
            allowedScopes: delegatableGrants,
            registrationClientUri: (clientId) => `${authSiteUrl()}/oauth2/register/${clientId}`,
          }),
        });
      }

      if (hasOAuth) {
        addAuthRoutes(http, {
          routeBase: routePrefix,
          ...oauthHttpHandlers,
        });
      }
    },

    /**
     * Create a Convex HTTP router with auth protocol routes already mounted.
     *
     * Defaults to the `/auth` prefix. Use {@link request.add add} instead when
     * you need to compose auth routes with app-specific HTTP routes in the same
     * router.
     *
     * ```ts
     * import { auth } from "./auth";
     *
     * export default auth.http();
     * ```
     */
    router: () => {
      const http = httpRouter();
      request.add(http);
      return http;
    },

    /**
     * Resolve mixed HTTP auth for a raw `httpAction`.
     *
     * Checks session auth first, then falls back to `Authorization: Bearer sk_*`
     * API keys. This is the low-level helper for endpoints that intentionally
     * accept either browser sessions or API keys.
     * Use `auth.request.context.optional(ctx, request)` to get a null-shaped
     * auth object instead of a `NOT_SIGNED_IN` error.
     *
     * ```ts
     * http.route({
     *   path: "/api/data",
     *   method: "GET",
     *   handler: httpAction(async (ctx, request) => {
     *     const authContext = await auth.request.context(ctx, request);
     *     return Response.json({
     *       userId: authContext.userId,
     *       source: authContext.source,
     *     });
     *   }),
     * });
     * ```
     */
    context: createHttpContext(
      bridgeRuntimeType<Parameters<typeof createHttpContext>[0]>(authBase),
      { issuer: authSiteUrl },
    ),

    /**
     * Wrap an HTTP action handler with Bearer token authentication.
     *
     * Extracts the `Authorization: Bearer <key>` header, verifies the
     * API key via `auth.key.verify()`, and injects `ctx.key` with the
     * verified key info. Returns structured JSON error responses for
     * missing/invalid/revoked/expired/rate-limited keys.
     *
     * If the handler returns a plain object, it is auto-wrapped in a
     * `200 JSON` response. If it returns a `Response`, CORS headers
     * are merged and the response is passed through.
     *
     * ```ts
     * const handler = auth.request.action(async (ctx, request) => {
     *   const data = await ctx.runQuery(api.data.get, { userId: ctx.key.userId });
     *   return { data };
     * });
     * http.route({ path: "/api/data", method: "GET", handler });
     * ```
     *
     * @param handler - Receives enriched `ctx` (with `ctx.key`) and the raw `Request`.
     * @param options.scope - Optional scope check; returns 403 if the key lacks permission.
     * @param options.cors - CORS config; defaults to site URLs from environment.
     */
    action: createHttpAction(
      authBase as Parameters<typeof createHttpAction>[0],
      getDefaultCorsOrigins,
    ),

    /**
     * Register a Bearer-authenticated route **and** its OPTIONS preflight
     * in a single call.
     *
     * ```ts
     * auth.request.route(http, {
     *   path: "/api/messages",
     *   method: "POST",
     *   handler: async (ctx, request) => {
     *     const { body } = await request.json();
     *     await ctx.runMutation(internal.messages.sendAsUser, {
     *       userId: ctx.key.userId,
     *       body,
     *     });
     *     return { success: true };
     *   },
     * });
     * ```
     *
     * @param http - The Convex HTTP router.
     * @param routeConfig.path - The URL path to match.
     * @param routeConfig.method - HTTP method (GET, POST, PUT, PATCH, DELETE).
     * @param routeConfig.handler - Receives enriched `ctx` (with `ctx.key`) and the raw `Request`.
     * @param routeConfig.scope - Optional scope check; returns 403 if the key lacks permission.
     * @param routeConfig.cors - CORS config; defaults to site URLs from environment.
     */
    route: createHttpRoute(
      createHttpAction(authBase as Parameters<typeof createHttpAction>[0], getDefaultCorsOrigins),
      getDefaultCorsOrigins,
    ),

    /**
     * Mount a remote MCP server (an OAuth-protected resource server) on `http`,
     * next to the other HTTP registrars (`add`, `route`). Requires `oauth` to be
     * configured in `defineAuth` — the MCP server shares the AS `scopes` and
     * bearer-token verification — and throws at registration time otherwise.
     * Tools are plain `{ description, scope, args, handler }` objects; each
     * handler's `args` are inferred from its Convex validator.
     */
    mcp: (
      http: HttpRouter,
      tools: Record<string, McpToolDef>,
      opts?: { name?: string; version?: string; mcpPath?: string },
    ): void => {
      if (config.oauth === undefined) {
        throw new Error(
          "`auth.request.mcp(...)` requires `oauth` to be configured in `defineAuth` — the MCP server is protected by the OAuth authorization server.",
        );
      }
      if (delegatableGrants.length === 0) {
        throw new Error(
          "`auth.request.mcp(...)` requires `permissions` with at least one grant — MCP tools delegate your app's grants, and none are defined.",
        );
      }
      const mcpPath = opts?.mcpPath ?? "/mcp";
      const canonicalResource = () => requireEnv("CONVEX_SITE_URL").replace(/\/+$/, "") + mcpPath;
      addMcpRoutes(http, {
        tools,
        name: opts?.name,
        version: opts?.version,
        scopes: delegatableGrants,
        mcpPath,
        resource: canonicalResource,
        authorizationServers: () => [authSiteUrl()],
        resolveScopes: async (_ctx, request) => {
          const token = extractBearerToken(request);
          if (token === null) return null;
          const verified = await verifyOAuthToken(token, {
            issuer: authSiteUrl(),
            resource: canonicalResource(),
          });
          return verified ? verified.scopes : null;
        },
      });
    },
  };

  const auth = Object.assign(authBase, { request });

  /**
   * App-owned HTTP router factory. `auth.http()` returns a Convex `httpRouter()`
   * with every auth protocol route mounted via {@link request.add}, so there is
   * exactly one route table.
   */
  const http = () => request.router();

  const { accountUnlink, passkeyDelete, totpDelete } = createFactorUnlinkHelpers(config);

  const enrichedAccount = Object.assign({}, auth.account, { unlink: accountUnlink });
  const passkeyHelpers = { remove: passkeyDelete };
  const totpHelpers = { remove: totpDelete };

  const enrichCtx = <DataModel extends GenericDataModel>(ctx: GenericActionCtx<DataModel>) =>
    enrichActionCtx(ctx, {
      ...ctx.auth,
      getUserIdentity: ctx.auth.getUserIdentity.bind(ctx.auth),
      config,
      account: enrichedAccount,
      passkey: passkeyHelpers,
      totp: totpHelpers,
      session: auth.session,
      member: auth.member,
      provider: auth.provider,
      event: auth.event,
    });

  return {
    auth,
    /**
     * Action called by the client to sign the user in.
     *
     * Also used for refreshing the session.
     */
    signIn: actionGeneric({
      args: {
        provider: v.optional(v.string()),
        params: v.optional(vPayloadRecord),
        verifier: v.optional(v.string()),
        refreshToken: v.optional(v.string()),
        calledBy: v.optional(v.string()),
      },
      handler: async (ctx, args): Promise<SignInActionResult> => {
        if (args.calledBy !== undefined) {
          log("INFO", `\`auth:signIn\` called by ${args.calledBy}`);
        }
        const provider = args.provider !== undefined ? getProviderOrThrow(args.provider) : null;
        const authSiteUrl =
          provider?.type === "oauth" || provider?.type === "connection"
            ? getAuthSiteUrl(ctx)
            : undefined;
        const result = await signInImpl(
          bridgeRuntimeType<Parameters<typeof signInImpl>[0]>(enrichCtx(ctx)),
          provider,
          args,
          {
            generateTokens: true,
            allowExtraProviders: false,
            authSiteUrl,
            resolveConnectionProtocol: group.resolveGroupConnectionConnectionProtocolOrThrow,
          },
        );
        const resultKind: string = result.kind;
        /** Exhaustive narrowing dispatch: only `signedIn` reshapes its session into tokens; every other variant passes through unchanged. */
        switch (result.kind) {
          case "signedIn":
            return {
              kind: "signedIn",
              session: result.session?.tokens ?? null,
            };
          case "redirect":
          case "started":
          case "passkeyOptions":
          case "totpRequired":
          case "totpSetup":
          case "deviceCode":
            return result;
          default:
            throw new Error(`Unexpected sign-in result kind: ${resultKind}`);
        }
      },
    }),
    /**
     * Action called by the client to invalidate the current session.
     */
    signOut: actionGeneric({
      args: {},
      handler: async (ctx) => {
        await callSignOut(ctx);
      },
    }),

    /**
     * Internal mutation used by the library to read and write
     * to the database during signin and signout.
     */
    store: internalMutationGeneric({
      args: vStoreArgs,
      handler: async (ctx: MutationCtx, args) => {
        return storeImpl(ctx, args, services);
      },
    }),

    /** App-owned HTTP router factory; call `auth.http()` from `convex/http.ts`. */
    http,
  };
}
