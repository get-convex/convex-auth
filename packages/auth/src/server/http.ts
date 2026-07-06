import {
  GenericActionCtx,
  GenericDataModel,
  HttpRouter,
  UserIdentity,
  httpActionGeneric,
} from "convex/server";
import { ConvexError } from "convex/values";
import { parse as parseCookies } from "cookie";

import { ErrorCode } from "../shared/codes";
import {
  buildCorsHeaders,
  corsPreflightHandler,
  corsPreflightResponse,
  registerCorsPreflight,
  withCors,
} from "./cors";
import type { AuthContext, OptionalAuthContext, UserDoc } from "./auth";
import type { ComponentCtx, ComponentReadCtx as HttpQueryCtx } from "./component/context";
import {
  createUnauthenticatedAuthContext,
  getAuthContextForUser,
  getSessionUserId,
} from "./context";
import { logError } from "./log";
import { verifyOAuthToken } from "./tokens";
import type { CorsConfig, HttpKeyContext } from "./types";
import { extractBearerToken } from "./utils/bearer";
import type { WellKnownEndpoint, WellKnownResponse } from "./wellknown";

type HttpIdentityCtx = {
  auth: {
    getUserIdentity: () => Promise<UserIdentity | null>;
  };
};
type HttpContextCtx = HttpIdentityCtx & HttpQueryCtx;

type HttpContextAuthLike = {
  user: {
    get: (ctx: HttpQueryCtx, args: { id: string }) => Promise<UserDoc | null>;
  };
  member: {
    get: (
      ctx: HttpQueryCtx,
      args: { userId: string; groupId: string },
    ) => Promise<{
      membership: unknown;
      roleIds: string[];
      grants: string[];
    }>;
    list: (
      ctx: HttpQueryCtx,
      opts: {
        where: { userId: string };
        paginationOpts: { numItems: number; cursor: string | null };
        withGrants: true;
      },
    ) => Promise<{ page: Array<{ groupId: string; roleIds: string[]; grants: string[] }> }>;
  };
  key: {
    verify: (
      ctx: ComponentCtx,
      args: { secret: string },
    ) => Promise<{
      userId: string;
      keyId: string;
      scopes: HttpKeyContext["key"]["scopes"];
    }>;
  };
};

type HttpContextRuntimeOptions = {
  issuer?: () => string;
};

/**
 * Auth context returned by `auth.request.context(ctx, request)`.
 *
 * This resolves raw HTTP authentication in two steps:
 * 1. session auth from `ctx.auth.getUserIdentity()`
 * 2. API key auth from `Authorization: Bearer sk_*`
 *
 * The `source` field tells you which authentication path succeeded.
 * When `source === "key"`, the verified API key metadata is available on
 * `key`.
 *
 * @example
 * ```ts
 * const authContext = await auth.request.context(ctx, request);
 * if (authContext.source === "key") {
 *   console.log(authContext.key.keyId);
 * }
 * ```
 */
export type HttpAuthContext =
  | (AuthContext & {
      /** The request authenticated through a browser or session token. */
      source: "session";
      /** No API key was used for this request. */
      key: null;
      oauth: null;
    })
  | (AuthContext & {
      /** The request authenticated through an API key. */
      source: "key";
      /** Verified API key metadata for the request. */
      key: HttpKeyContext["key"];
      oauth: null;
    })
  | (AuthContext & {
      source: "oauth";
      key: null;
      oauth: { clientId: string; scopes: string[] };
    });

/**
 * Nullable HTTP auth context returned by
 * `auth.request.context.optional(ctx, request)`.
 *
 * This preserves a stable auth-shaped object for raw `httpAction` handlers
 * that allow anonymous callers.
 */
export type OptionalHttpAuthContext =
  | (OptionalAuthContext & {
      /** No authentication source was resolved. */
      source: null;
      /** No API key metadata is available. */
      key: null;
      oauth: null;
    })
  | HttpAuthContext;

/**
 * Configuration for {@link defineAuth().request.context}.
 *
 * This mirrors {@link AuthContextConfig} for raw HTTP handlers and adds support
 * for enriching mixed session/API-key auth results.
 *
 * @typeParam TResolve - Extra fields returned from `resolve()` and merged into
 *   the resolved HTTP auth context.
 *
 * @example
 * ```ts
 * const authContext = await auth.request.context(ctx, request, {
 *   resolve: async (_ctx, user, authState) => ({
 *     email: user.email,
 *     isMachineRequest: authState.source === "key",
 *   }),
 * });
 * ```
 */
export type HttpAuthContextConfig<
  TResolve extends Record<string, unknown> = Record<string, never>,
  TCtx extends HttpContextCtx = HttpContextCtx,
> = {
  /**
   * Attach additional derived fields to the resolved HTTP auth context.
   *
   * This callback runs only when authentication succeeds.
   */
  resolve?: (ctx: TCtx, user: UserDoc, auth: HttpAuthContext) => Promise<TResolve> | TResolve;
  /**
   * Override or wrap HTTP auth resolution.
   *
   * Return `undefined` to use the built-in session-or-key resolver, `null` for
   * an explicit unauthenticated state, or a fully resolved
   * {@link HttpAuthContext}.
   */
  authResolve?: (
    ctx: TCtx,
    fallback: () => Promise<HttpAuthContext | null>,
  ) => Promise<HttpAuthContext | null | undefined> | HttpAuthContext | null | undefined;
  /**
   * RFC 8707 resource assertion (opt-in). When set, an OAuth `at+jwt` bearer is
   * only accepted on this route if its `resource` claim equals this value — so a
   * token minted for a different protected resource is not honored here. Omit it
   * (the default) to accept any valid OAuth identity; capability is still bounded
   * by scope grant-intersection regardless. The `/mcp` route sets this to its
   * canonical resource.
   */
  resource?: string;
};

function createNotSignedInError() {
  return new ConvexError({
    code: ErrorCode.NOT_SIGNED_IN,
    message: "Authentication required.",
  });
}

/** A `{ code, message }` error body for the non-OAuth JSON HTTP surface. */
export type JsonErrorBody = { code: string; message: string };

/**
 * Extract a `{ code, message }` body from a thrown value for the non-OAuth JSON
 * HTTP surface. A structured `ConvexError` carrying `code`/`message` is surfaced
 * verbatim; anything else collapses to an opaque `INTERNAL_ERROR`.
 */
export function convexErrorToBody(error: unknown): JsonErrorBody {
  if (
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null &&
    "code" in error.data &&
    "message" in error.data
  ) {
    const { code, message } = error.data as { code: string; message: string };
    return { code, message };
  }
  return { code: ErrorCode.INTERNAL_ERROR, message: "An unexpected error occurred." };
}

/**
 * Build a JSON error `Response` for the non-OAuth HTTP surface, in the single
 * `{ code, message }` shape. OAuth wire endpoints use the RFC 6749
 * `{ error, error_description }` shape instead (see `oauth/*`).
 */
export function jsonError(
  status: number,
  body: JsonErrorBody,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

async function getHttpKeyContext(
  auth: HttpContextAuthLike,
  ctx: HttpContextCtx,
  request: Request,
): Promise<HttpAuthContext | null> {
  const token = extractBearerToken(request);
  if (token === null || !token.startsWith("sk_")) {
    return null;
  }

  try {
    /**
     * The `Bearer sk_*` branch only runs inside an HTTP action, where the
     * resolved `ctx` additionally carries the `runMutation` that `key.verify`
     * needs. The HTTP-context surface is otherwise query-shaped, so this one
     * narrow assertion supplies that single missing member at the boundary.
     */
    const keyVerifyCtx: ComponentCtx = ctx as HttpContextCtx & Pick<ComponentCtx, "runMutation">;
    const verified = await auth.key.verify(keyVerifyCtx, {
      secret: token,
    });
    const authContext = await getAuthContextForUser(auth, ctx, verified.userId);
    return {
      ...authContext,
      source: "key",
      key: {
        userId: verified.userId,
        keyId: verified.keyId,
        scopes: verified.scopes,
      },
      oauth: null,
    };
  } catch (err) {
    console.error("[auth] HTTP key verification failed", { err });
    return null;
  }
}

async function getHttpOAuthContext(
  auth: HttpContextAuthLike,
  ctx: HttpContextCtx,
  request: Request,
  resource: string | undefined,
  issuer: string | undefined,
): Promise<HttpAuthContext | null> {
  const token = extractBearerToken(request);
  if (token === null || token.startsWith("sk_")) return null;
  const oauthPayload = await verifyOAuthToken(token, {
    ...(issuer !== undefined ? { issuer } : {}),
    ...(resource !== undefined ? { resource } : {}),
  });
  if (!oauthPayload) return null;
  try {
    const authContext = await getAuthContextForUser(
      auth,
      ctx,
      oauthPayload.userId,
      oauthPayload.scopes,
    );
    return {
      ...authContext,
      source: "oauth",
      key: null,
      oauth: { clientId: oauthPayload.clientId, scopes: oauthPayload.scopes },
    };
  } catch {
    return null;
  }
}

async function resolveHttpAuthContext(
  auth: HttpContextAuthLike,
  ctx: HttpContextCtx,
  request: Request,
  resource: string | undefined,
  issuer: string | undefined,
): Promise<HttpAuthContext | null> {
  const oauthContext = await getHttpOAuthContext(auth, ctx, request, resource, issuer);
  if (oauthContext !== null) return oauthContext;

  const sessionUserId = await getSessionUserId(ctx);
  if (sessionUserId !== null) {
    const authContext = await getAuthContextForUser(auth, ctx, sessionUserId);
    return {
      ...authContext,
      source: "session",
      key: null,
      oauth: null,
    };
  }

  return await getHttpKeyContext(auth, ctx, request);
}

/**
 * Resolver for `auth.request.context(ctx, request, config?)`.
 *
 * Authentication sources are tried in a fixed order: OAuth access tokens
 * first (an `at+jwt` bearer is also a valid Convex identity, so it must be
 * classified as `oauth` before the session branch would claim it), then the
 * session identity, then `Bearer sk_*` API keys. Session therefore takes
 * precedence over an API key when both are present.
 */
export interface HttpContextResolver {
  <
    TResolve extends Record<string, unknown> = Record<string, never>,
    TCtx extends HttpContextCtx = HttpContextCtx,
  >(
    ctx: TCtx,
    request: Request,
    config?: HttpAuthContextConfig<TResolve, TCtx>,
  ): Promise<HttpAuthContext & TResolve>;
}

/**
 * Nullable variant for `auth.request.context.optional(ctx, request, config?)`.
 */
export interface OptionalHttpContextResolver {
  <
    TResolve extends Record<string, unknown> = Record<string, never>,
    TCtx extends HttpContextCtx = HttpContextCtx,
  >(
    ctx: TCtx,
    request: Request,
    config?: HttpAuthContextConfig<TResolve, TCtx>,
  ): Promise<OptionalHttpAuthContext & TResolve>;
}

async function resolveHttpContext(
  auth: HttpContextAuthLike,
  ctx: HttpContextCtx,
  request: Request,
  config: HttpAuthContextConfig<Record<string, unknown>> | undefined,
  optional: boolean,
  options: HttpContextRuntimeOptions,
) {
  const fallback = () =>
    resolveHttpAuthContext(auth, ctx, request, config?.resource, options.issuer?.());
  const authOverride = config?.authResolve ? await config.authResolve(ctx, fallback) : undefined;
  const resolved = authOverride === undefined ? await fallback() : authOverride;

  if (resolved === null) {
    if (!optional) {
      throw createNotSignedInError();
    }
    return {
      ...createUnauthenticatedAuthContext(),
      source: null,
      key: null,
      oauth: null,
    };
  }

  const extra = config?.resolve ? await config.resolve(ctx, resolved.user, resolved) : {};

  return {
    ...resolved,
    ...extra,
  };
}

/**
 * @internal
 * Create the implementation behind `auth.request.context(...)` and
 * `auth.request.context.optional(...)`.
 *
 * The two assertions below bind a concrete (monomorphic) closure to the
 * generic call-signature interfaces {@link HttpContextResolver} /
 * {@link OptionalHttpContextResolver}; TypeScript cannot infer those generics
 * from a non-generic body, so the typed assertion is the irreducible bridge.
 */
export function createHttpContext(
  auth: HttpContextAuthLike,
  options: HttpContextRuntimeOptions = {},
): HttpContextResolver & { optional: OptionalHttpContextResolver } {
  const required = ((
    ctx: HttpContextCtx,
    request: Request,
    config?: HttpAuthContextConfig<Record<string, unknown>>,
  ) => resolveHttpContext(auth, ctx, request, config, false, options)) as HttpContextResolver & {
    optional: OptionalHttpContextResolver;
  };

  required.optional = ((
    ctx: HttpContextCtx,
    request: Request,
    config?: HttpAuthContextConfig<Record<string, unknown>>,
  ) =>
    resolveHttpContext(auth, ctx, request, config, true, options)) as OptionalHttpContextResolver;

  return required;
}

/**
 * Build the Bearer-key HTTP action wrapper behind `auth.request.action(...)`.
 *
 * Returns a function that wraps a handler with `Authorization: Bearer sk_*`
 * verification, optional scope checks, CORS headers, and JSON error envelopes.
 *
 * @param auth - Provides `key.verify` for API key verification.
 * @param defaultOrigins - Allowed CORS origins (or a getter) used when a route
 *   supplies no `cors` config.
 */
export function createHttpAction(
  auth: {
    key: {
      verify: (
        ctx: GenericActionCtx<GenericDataModel>,
        args: { secret: string },
      ) => Promise<{
        userId: string;
        keyId: string;
        scopes: HttpKeyContext["key"]["scopes"];
      }>;
    };
  },
  defaultOrigins: string[] | (() => string[]),
) {
  return (
    handler: (
      ctx: GenericActionCtx<GenericDataModel> & HttpKeyContext,
      request: Request,
    ) => Promise<Response | Record<string, unknown>>,
    options?: {
      scope?: { resource: string; action: string };
      cors?: CorsConfig;
    },
  ) => {
    return httpActionGeneric(async (genericCtx, request) => {
      const corsHeaders = buildCorsHeaders(request, options?.cors, defaultOrigins);

      try {
        const rawKey = extractBearerToken(request);
        if (rawKey === null) {
          return jsonError(
            401,
            {
              code: ErrorCode.MISSING_BEARER_TOKEN,
              message: "Missing or malformed Authorization: Bearer header.",
            },
            corsHeaders,
          );
        }

        let keyResult:
          | {
              ok: true;
              value: {
                userId: string;
                keyId: string;
                scopes: HttpKeyContext["key"]["scopes"];
              };
            }
          | { ok: false; error: unknown };
        try {
          const value = await auth.key.verify(genericCtx, { secret: rawKey });
          keyResult = { ok: true, value };
        } catch (error) {
          keyResult = { ok: false, error };
        }

        if (!keyResult.ok) {
          if (
            keyResult.error instanceof ConvexError &&
            typeof keyResult.error.data === "object" &&
            keyResult.error.data !== null &&
            "code" in keyResult.error.data &&
            "message" in keyResult.error.data
          ) {
            return jsonError(403, convexErrorToBody(keyResult.error), corsHeaders);
          }
          throw keyResult.error;
        }

        if (
          options?.scope &&
          !keyResult.value.scopes.can(options.scope.resource, options.scope.action)
        ) {
          return jsonError(
            403,
            {
              code: ErrorCode.SCOPE_CHECK_FAILED,
              message: "This API key does not have the required permissions.",
            },
            corsHeaders,
          );
        }

        const enrichedCtx = Object.assign(genericCtx, {
          key: {
            userId: keyResult.value.userId,
            keyId: keyResult.value.keyId,
            scopes: keyResult.value.scopes,
          },
        });
        const result = await handler(enrichedCtx, request);

        return result instanceof Response
          ? (() => {
              const headers = new Headers(result.headers);
              for (const [k, val] of Object.entries(corsHeaders)) {
                if (!headers.has(k)) headers.set(k, val);
              }
              return new Response(result.body, {
                status: result.status,
                statusText: result.statusText,
                headers,
              });
            })()
          : new Response(JSON.stringify(result), {
              status: 200,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
              },
            });
      } catch (error) {
        logError(error);
        return jsonError(
          500,
          { code: ErrorCode.INTERNAL_ERROR, message: "An unexpected error occurred." },
          corsHeaders,
        );
      }
    });
  };
}

/**
 * Build the route registrar behind `auth.request.route(...)`.
 *
 * Returns a function that registers a Bearer-authenticated route plus its
 * matching `OPTIONS` CORS preflight in one call.
 *
 * @param wrapAction - The wrapper produced by {@link createHttpAction}.
 * @param defaultOrigins - Allowed CORS origins (or a getter) for the preflight.
 */
export function createHttpRoute(
  wrapAction: ReturnType<typeof createHttpAction>,
  defaultOrigins: string[] | (() => string[]),
) {
  return (
    http: { route: (config: unknown) => void },
    routeConfig: {
      path: string;
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      handler: (
        ctx: GenericActionCtx<GenericDataModel> & HttpKeyContext,
        request: Request,
      ) => Promise<Response | Record<string, unknown>>;
      scope?: { resource: string; action: string };
      cors?: CorsConfig;
    },
  ) => {
    http.route({
      path: routeConfig.path,
      method: "OPTIONS",
      handler: httpActionGeneric(async (_ctx, request) =>
        corsPreflightResponse(request, routeConfig.cors, defaultOrigins),
      ),
    });

    http.route({
      path: routeConfig.path,
      method: routeConfig.method,
      handler: wrapAction(routeConfig.handler, {
        scope: routeConfig.scope,
        cors: routeConfig.cors,
      }),
    });
  };
}

/**
 * Wrap an HTTP action so thrown `ConvexError`s become JSON error responses.
 *
 * Structured `{ code, message }` errors return `errorStatusCode`; other
 * `ConvexError`s return that status with a plain status text; any other error
 * is logged and returns a 500.
 *
 * @param errorStatusCode - Status used for `ConvexError`s.
 * @param action - The wrapped HTTP action.
 */
export function convertErrorsToResponse(
  errorStatusCode: number,
  action: (ctx: GenericActionCtx<GenericDataModel>, request: Request) => Promise<Response>,
) {
  return async (ctx: GenericActionCtx<GenericDataModel>, request: Request) => {
    try {
      return await action(ctx, request);
    } catch (error) {
      if (
        error instanceof ConvexError &&
        typeof error.data === "object" &&
        error.data !== null &&
        "code" in error.data &&
        "message" in error.data
      ) {
        return jsonError(errorStatusCode, convexErrorToBody(error));
      }
      if (error instanceof ConvexError) {
        return new Response(null, {
          status: errorStatusCode,
          statusText: typeof error.data === "string" ? error.data : "Error",
        });
      }
      logError(error);
      return new Response(null, {
        status: 500,
        statusText: "Internal Server Error",
      });
    }
  };
}

/** Parse the request's `Cookie` header into a name-to-value record. */
export function getCookies(request: Request): Record<string, string | undefined> {
  return parseCookies(request.headers.get("Cookie") ?? "");
}

/** Parsed group connection runtime route: connection id, protocol, and remaining path segments. */
export type ConnectionRuntimeRoute = {
  pathname?: string;
  connectionId: string;
  protocol: "oidc" | "saml" | "scim";
  rest: string[];
};

function parseConnectionRuntimeRoute(
  pathname: string,
  routeBase: string,
): ConnectionRuntimeRoute | null {
  const runtimePrefix = `${routeBase}/`;
  const runtimeParts = pathname.startsWith(runtimePrefix)
    ? pathname.slice(runtimePrefix.length).split("/").filter(Boolean)
    : [];
  const [runtimeConnectionId, protocol, ...rest] = runtimeParts;
  if (
    runtimeConnectionId === undefined ||
    (protocol !== "oidc" && protocol !== "saml" && protocol !== "scim") ||
    rest.length === 0
  ) {
    return null;
  }
  return {
    pathname,
    connectionId: runtimeConnectionId,
    protocol,
    rest,
  };
}

/**
 * Register the OpenID discovery and JWKS endpoints on an HTTP router.
 *
 * Adds `<routeBase>/.well-known/openid-configuration` and
 * `<routeBase>/.well-known/jwks.json`. OAuth-specific discovery fields are
 * included only when `deps.oauth` is provided.
 *
 * Discovery is served at both the issuer prefix and the root, including the
 * RFC 8414 `oauth-authorization-server` path conventions, because clients
 * treat either the issuer (`/auth`) or the origin as the base. These exact
 * routes win over the static-hosting catch-all, so zero-config
 * `mcp login <url>` resolves to JSON rather than the SPA HTML fallback.
 */
export function addOpenIdRoutes(
  http: HttpRouter,
  deps: {
    getIssuer: () => string;
    getJwks: () => string;
    routeBase?: string;
    oauth?: {
      scopes?: string[];
    };
  },
) {
  const cacheControl = "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400";
  const routeBase = deps.routeBase ?? "";

  const buildMetadata = () => {
    const issuer = deps.getIssuer();
    const body: Record<string, unknown> = {
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
    };
    if (deps.oauth) {
      body.authorization_endpoint = `${issuer}/oauth2/authorize`;
      body.token_endpoint = `${issuer}/oauth2/token`;
      body.registration_endpoint = `${issuer}/oauth2/register`;
      body.response_types_supported = ["code"];
      body.grant_types_supported = ["authorization_code", "refresh_token", "client_credentials"];
      body.code_challenge_methods_supported = ["S256"];
      body.token_endpoint_auth_methods_supported = [
        "client_secret_post",
        "client_secret_basic",
        "none",
      ];
      body.scopes_supported = deps.oauth.scopes ?? ["openid", "profile", "email", "offline_access"];
    }
    return body;
  };

  const metadataHandler = httpActionGeneric(
    withCors(async () => {
      return new Response(JSON.stringify(buildMetadata()), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": cacheControl },
      });
    }),
  );

  const jwksHandler = httpActionGeneric(
    withCors(async () => {
      return new Response(deps.getJwks(), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": cacheControl },
      });
    }),
  );

  const oidcPaths = new Set<string>([
    `${routeBase}/.well-known/openid-configuration`,
    "/.well-known/openid-configuration",
  ]);
  const asPaths = deps.oauth
    ? new Set<string>([
        `/.well-known/oauth-authorization-server${routeBase}`,
        `${routeBase}/.well-known/oauth-authorization-server`,
        "/.well-known/oauth-authorization-server",
      ])
    : new Set<string>();
  const jwksPaths = new Set<string>([
    `${routeBase}/.well-known/jwks.json`,
    "/.well-known/jwks.json",
  ]);

  for (const path of [...oidcPaths, ...asPaths]) {
    http.route({ path, method: "GET", handler: metadataHandler });
  }
  for (const path of jwksPaths) {
    http.route({ path, method: "GET", handler: jwksHandler });
  }
  registerCorsPreflight(http, [...oidcPaths, ...asPaths, ...jwksPaths]);
}

/** Register root `/.well-known/*` app discovery routes on an HTTP router. */
export function addWellKnownRoutes(
  http: HttpRouter,
  deps: {
    getResponse: (endpoint: WellKnownEndpoint) => WellKnownResponse | null;
  },
) {
  const routes: Array<{ endpoint: WellKnownEndpoint; path: string }> = [
    {
      endpoint: "apple-app-site-association",
      path: "/.well-known/apple-app-site-association",
    },
    { endpoint: "assetlinks.json", path: "/.well-known/assetlinks.json" },
    { endpoint: "webauthn", path: "/.well-known/webauthn" },
    { endpoint: "change-password", path: "/.well-known/change-password" },
    { endpoint: "security.txt", path: "/.well-known/security.txt" },
  ];

  for (const route of routes) {
    http.route({
      path: route.path,
      method: "GET",
      handler: httpActionGeneric(async () => {
        const result = deps.getResponse(route.endpoint);
        if (result === null) {
          return new Response(null, { status: 404 });
        }
        return new Response(result.body, {
          status: result.status,
          headers: result.headers,
        });
      }),
    });
  }
}

/**
 * Register the OAuth sign-in and callback routes on an HTTP router.
 *
 * Adds `GET <routeBase>/signin/*` and `GET`/`POST <routeBase>/callback/*`.
 */
export function addAuthRoutes(
  http: HttpRouter,
  deps: {
    handleSignIn: (ctx: GenericActionCtx<GenericDataModel>, request: Request) => Promise<Response>;
    handleCallback: (
      ctx: GenericActionCtx<GenericDataModel>,
      request: Request,
    ) => Promise<Response>;
    routeBase?: string;
  },
) {
  const routeBase = deps.routeBase ?? "/api/auth";
  const routePrefix = routeBase === "" ? "" : routeBase;
  http.route({
    pathPrefix: `${routePrefix}/signin/`,
    method: "GET",
    handler: httpActionGeneric(deps.handleSignIn),
  });

  const callbackHandler = httpActionGeneric(deps.handleCallback);

  http.route({
    pathPrefix: `${routePrefix}/callback/`,
    method: "GET",
    handler: callbackHandler,
  });

  http.route({
    pathPrefix: `${routePrefix}/callback/`,
    method: "POST",
    handler: callbackHandler,
  });
}

/**
 * Register the OAuth provider authorize, token, registration, and RFC 7592
 * client-management endpoints on an HTTP router.
 *
 * Adds `GET <base>/oauth2/authorize`, `POST <base>/oauth2/token`,
 * `POST <base>/oauth2/register` (DCR), and `GET`/`PUT`/`DELETE`
 * `<base>/oauth2/register/<client_id>` (management). The exact `register` path
 * serves DCR; the `register/` prefix serves per-client management.
 */
export function addOAuthProviderRoutes(
  http: HttpRouter,
  deps: {
    handleAuthorize: (
      ctx: GenericActionCtx<GenericDataModel>,
      request: Request,
    ) => Promise<Response>;
    handleToken: (ctx: GenericActionCtx<GenericDataModel>, request: Request) => Promise<Response>;
    handleRegister: (
      ctx: GenericActionCtx<GenericDataModel>,
      request: Request,
    ) => Promise<Response>;
    handleManage: (ctx: GenericActionCtx<GenericDataModel>, request: Request) => Promise<Response>;
    routeBase?: string;
  },
) {
  const base = deps.routeBase ?? "";
  const authorizePath = `${base}/oauth2/authorize`;
  const tokenPath = `${base}/oauth2/token`;
  const registerPath = `${base}/oauth2/register`;
  const managePrefix = `${registerPath}/`;

  http.route({
    path: authorizePath,
    method: "GET",
    handler: httpActionGeneric(withCors(deps.handleAuthorize)),
  });
  http.route({
    path: tokenPath,
    method: "POST",
    handler: httpActionGeneric(withCors(deps.handleToken)),
  });
  http.route({
    path: registerPath,
    method: "POST",
    handler: httpActionGeneric(withCors(deps.handleRegister)),
  });
  for (const method of ["GET", "PUT", "DELETE"] as const) {
    http.route({
      pathPrefix: managePrefix,
      method,
      handler: httpActionGeneric(withCors(deps.handleManage)),
    });
  }
  http.route({ pathPrefix: managePrefix, method: "OPTIONS", handler: corsPreflightHandler });
  registerCorsPreflight(http, [authorizePath, tokenPath, registerPath]);
}

/**
 * Register the group connection runtime routes (SAML, OIDC, SCIM) on a router.
 *
 * Mounts method-specific handlers under `<routeBase>/<connectionId>/<protocol>/...`
 * (plus an optional shared OIDC callback path), dispatching by
 * `${protocol}:${endpoint}` and returning SCIM errors for unmatched
 * `PATCH`/`DELETE` requests.
 */
export function addConnectionRoutes(
  http: HttpRouter,
  deps: {
    routeBase: string;
    sharedOidcCallbackPath?: string;
    convertErrorsToResponse: typeof convertErrorsToResponse;
    handleSamlMetadata: (
      ctx: GenericActionCtx<GenericDataModel>,
      request: Request,
      route: ConnectionRuntimeRoute,
    ) => Promise<Response>;
    handleSamlSignIn: (
      ctx: GenericActionCtx<GenericDataModel>,
      request: Request,
      route: ConnectionRuntimeRoute,
    ) => Promise<Response>;
    handleOidcSignIn: (
      ctx: GenericActionCtx<GenericDataModel>,
      request: Request,
      route: ConnectionRuntimeRoute,
    ) => Promise<Response>;
    handleOidcCallback: (
      ctx: GenericActionCtx<GenericDataModel>,
      request: Request,
      route: ConnectionRuntimeRoute,
    ) => Promise<Response>;
    handleOidcSharedCallback: (
      ctx: GenericActionCtx<GenericDataModel>,
      request: Request,
    ) => Promise<Response>;
    handleSamlAcs: (
      ctx: GenericActionCtx<GenericDataModel>,
      request: Request,
      route: ConnectionRuntimeRoute,
    ) => Promise<Response>;
    handleSamlSlo: (
      ctx: GenericActionCtx<GenericDataModel>,
      request: Request,
      route: ConnectionRuntimeRoute,
    ) => Promise<Response>;
    handleScimRequest: (
      ctx: GenericActionCtx<GenericDataModel>,
      request: Request,
    ) => Promise<Response>;
    scimError: (status: number, scimType: string, detail: string) => Response;
  },
) {
  const routePrefix = `${deps.routeBase}/`;
  const sharedOidcCallbackPath = deps.sharedOidcCallbackPath
    ? (() => {
        if (/^https?:\/\//.test(deps.sharedOidcCallbackPath)) {
          return new URL(deps.sharedOidcCallbackPath).pathname;
        }
        return deps.sharedOidcCallbackPath.startsWith("/")
          ? deps.sharedOidcCallbackPath
          : `/${deps.sharedOidcCallbackPath}`;
      })()
    : undefined;

  if (sharedOidcCallbackPath) {
    http.route({
      path: sharedOidcCallbackPath,
      method: "GET",
      handler: httpActionGeneric(
        deps.convertErrorsToResponse(400, async (ctx, request) =>
          deps.handleOidcSharedCallback(ctx, request),
        ),
      ),
    });

    http.route({
      path: sharedOidcCallbackPath,
      method: "POST",
      handler: httpActionGeneric(
        deps.convertErrorsToResponse(400, async (ctx, request) =>
          deps.handleOidcSharedCallback(ctx, request),
        ),
      ),
    });
  }

  type ConnRouteHandler = (
    ctx: GenericActionCtx<GenericDataModel>,
    request: Request,
    route: ConnectionRuntimeRoute,
  ) => Promise<Response>;
  const scimRoute: ConnRouteHandler = (ctx, request) => deps.handleScimRequest(ctx, request);

  const matchConnectionRoute = (
    route: ConnectionRuntimeRoute | null,
    handlers: Record<string, ConnRouteHandler>,
  ): ConnRouteHandler | null => {
    const endpoint = route?.rest[0];
    if (!route || endpoint === undefined) return null;
    const key =
      route.protocol === "scim"
        ? endpoint === "v2"
          ? "scim:v2"
          : null
        : route.rest.length === 1
          ? `${route.protocol}:${endpoint}`
          : null;
    return key ? (handlers[key] ?? null) : null;
  };

  const connectionRouteHandler = (handlers: Record<string, ConnRouteHandler>) =>
    httpActionGeneric(
      deps.convertErrorsToResponse(400, async (ctx, request) => {
        const route = parseConnectionRuntimeRoute(new URL(request.url).pathname, deps.routeBase);
        const handler = matchConnectionRoute(route, handlers);
        if (!handler || !route) {
          throw new ConvexError({
            code: ErrorCode.INVALID_PARAMETERS,
            message: "Invalid connection runtime path.",
          });
        }
        return await handler(ctx, request, route);
      }),
    );

  http.route({
    pathPrefix: routePrefix,
    method: "GET",
    handler: connectionRouteHandler({
      "saml:metadata": deps.handleSamlMetadata,
      "saml:signin": deps.handleSamlSignIn,
      "saml:acs": deps.handleSamlAcs,
      "saml:slo": deps.handleSamlSlo,
      "oidc:signin": deps.handleOidcSignIn,
      "oidc:callback": deps.handleOidcCallback,
      "scim:v2": scimRoute,
    }),
  });

  http.route({
    pathPrefix: routePrefix,
    method: "POST",
    handler: connectionRouteHandler({
      "saml:acs": deps.handleSamlAcs,
      "saml:slo": deps.handleSamlSlo,
      "oidc:callback": deps.handleOidcCallback,
      "scim:v2": scimRoute,
    }),
  });

  http.route({
    pathPrefix: routePrefix,
    method: "PUT",
    handler: connectionRouteHandler({
      "scim:v2": scimRoute,
    }),
  });

  for (const method of ["PATCH", "DELETE"] as const) {
    http.route({
      pathPrefix: routePrefix,
      method,
      handler: httpActionGeneric(async (ctx, request) => {
        const route = parseConnectionRuntimeRoute(new URL(request.url).pathname, deps.routeBase);
        if (!route || route.protocol !== "scim" || route.rest[0] !== "v2") {
          return deps.scimError(404, "notFound", "SCIM resource not found.");
        }
        return await deps.handleScimRequest(ctx, request);
      }),
    });
  }
}
