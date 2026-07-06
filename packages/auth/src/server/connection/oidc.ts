import { sha256 } from "@oslojs/crypto/sha2";
import { encodeBase64, encodeBase64urlNoPadding } from "@oslojs/encoding";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify } from "jose";
import type { JWTVerifyGetKey, JWTVerifyOptions } from "jose";

import type { AuthComponentApi } from "../component/api";

import { assertSafeIdpFetchUrl, assertSafeIdpHost } from "../../shared/fetch/guard";
import { log } from "../log";
import { normalizeOAuthTokenResponse } from "../oauth/normalize";
import type {
  OIDCClaimMapping,
  OAuthMaterializedConfig,
  OAuthProfile,
  OAuthTokens,
} from "../types";
import { createCache } from "../utils/cache";
import { retryWithBackoff } from "../utils/retry";
import { withSpan } from "../utils/span";
import { finalizeNormalizedProfile, normalizeStringArray } from "./profile";
import { groupOidcProviderId, getGroupOidcUrls } from "./shared";

const OIDC_JWKS_CACHE = createCache<string, ReturnType<typeof createRemoteJWKSet>>({
  capacity: 128,
  timeToLiveMs: 60 * 60 * 1000,
  lookup: (cacheKey) => {
    const key = JSON.parse(cacheKey) as {
      url: string;
      runtimeOrigin?: string;
      externalHost?: string;
    };
    const fetchImpl =
      key.runtimeOrigin !== undefined || key.externalHost !== undefined
        ? createGroupConnectionOidcFetchFromParts(key.runtimeOrigin, key.externalHost)
        : undefined;
    return fetchImpl
      ? createRemoteJWKSet(new URL(key.url), { [customFetch]: fetchImpl })
      : createRemoteJWKSet(new URL(key.url));
  },
});

type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
};

type OidcUserInfo = {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  groups?: unknown;
  roles?: unknown;
};

function validateOidcDiscovery(data: unknown): OidcDiscovery {
  if (typeof data !== "object" || data === null) {
    throw new Error("OIDC discovery response is not an object.");
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.issuer !== "string") {
    throw new Error("OIDC discovery is missing 'issuer'.");
  }
  if (typeof obj.authorization_endpoint !== "string") {
    throw new Error("OIDC discovery is missing 'authorization_endpoint'.");
  }
  if (typeof obj.token_endpoint !== "string") {
    throw new Error("OIDC discovery is missing 'token_endpoint'.");
  }
  if (typeof obj.jwks_uri !== "string") {
    throw new Error("OIDC discovery is missing 'jwks_uri'.");
  }
  return {
    issuer: obj.issuer,
    authorization_endpoint: obj.authorization_endpoint,
    token_endpoint: obj.token_endpoint,
    jwks_uri: obj.jwks_uri,
    userinfo_endpoint:
      typeof obj.userinfo_endpoint === "string" ? obj.userinfo_endpoint : undefined,
    token_endpoint_auth_methods_supported: Array.isArray(obj.token_endpoint_auth_methods_supported)
      ? obj.token_endpoint_auth_methods_supported.filter(
          (v: unknown): v is string => typeof v === "string",
        )
      : undefined,
    id_token_signing_alg_values_supported: Array.isArray(obj.id_token_signing_alg_values_supported)
      ? obj.id_token_signing_alg_values_supported.filter(
          (v: unknown): v is string => typeof v === "string",
        )
      : undefined,
  };
}

function validateOidcUserInfo(data: unknown): OidcUserInfo {
  if (typeof data !== "object" || data === null) {
    return {};
  }
  const obj = data as Record<string, unknown>;
  return {
    sub: typeof obj.sub === "string" ? obj.sub : undefined,
    email: typeof obj.email === "string" ? obj.email : undefined,
    email_verified: typeof obj.email_verified === "boolean" ? obj.email_verified : undefined,
    name: typeof obj.name === "string" ? obj.name : undefined,
    picture: typeof obj.picture === "string" ? obj.picture : undefined,
    groups: obj.groups,
    roles: obj.roles,
  };
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

function resolveOidcAuthMethod(
  client: Record<string, unknown>,
  discoveredMethods: string[],
): "client_secret_basic" | "client_secret_post" {
  if (client.authMethod === "client_secret_basic" || client.authMethod === "client_secret_post") {
    return client.authMethod;
  }
  return discoveredMethods.includes("client_secret_basic")
    ? "client_secret_basic"
    : "client_secret_post";
}

function normalizeOidcIssuer(value: unknown): string {
  return typeof value === "string" ? value.replace(/\/$/, "") : "";
}

/**
 * Typed shape of the `oidc` section of a group connection's `config` blob —
 * the OIDC counterpart to {@link SamlConfigShape}. The stored `config` is
 * `v.any()`, so {@link getOidcConfig} performs the single boundary cast to
 * this shape and call sites read it without further casts.
 */
export type OidcConfigShape = {
  enabled?: boolean;
  discovery?: {
    issuer?: string;
    discoveryUrl?: string;
    jwksUri?: string;
    audience?: string | string[];
  };
  client?: {
    id?: string;
    secret?: string;
    authMethod?: "client_secret_post" | "client_secret_basic";
  };
  request?: {
    scopes?: string[];
    loginHint?: string;
    authorizationParams?: Record<string, string>;
  };
  security?: {
    clockToleranceSeconds?: number;
    strictIssuer?: boolean;
  };
  profile?: {
    mapping?: OIDCClaimMapping;
    extraFields?: Record<string, string>;
  };
};

function getOidcSections(config: Record<string, unknown>) {
  return {
    discovery:
      typeof config.discovery === "object" && config.discovery !== null
        ? (config.discovery as Record<string, unknown>)
        : {},
    client:
      typeof config.client === "object" && config.client !== null
        ? (config.client as Record<string, unknown>)
        : {},
    request:
      typeof config.request === "object" && config.request !== null
        ? (config.request as Record<string, unknown>)
        : {},
    security:
      typeof config.security === "object" && config.security !== null
        ? (config.security as Record<string, unknown>)
        : {},
    profile:
      typeof config.profile === "object" && config.profile !== null
        ? (config.profile as Record<string, unknown>)
        : {},
  };
}

async function discoverOidcConfiguration(
  ctx: GenericActionCtx<GenericDataModel>,
  componentConnection: AuthComponentApi["connection"],
  config: Record<string, unknown>,
): Promise<OidcDiscovery> {
  const { discovery } = getOidcSections(config);
  const discoveryUrl =
    typeof discovery.discoveryUrl === "string"
      ? discovery.discoveryUrl
      : typeof discovery.issuer === "string"
        ? `${discovery.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`
        : null;

  if (!discoveryUrl) {
    throw new Error("Group connection OIDC requires an issuer or discoveryUrl.");
  }

  const runtimeOrigin =
    typeof discovery.discoveryUrl === "string" ? new URL(discovery.discoveryUrl).origin : undefined;
  const externalHost =
    typeof discovery.issuer === "string" ? new URL(discovery.issuer).host : undefined;

  assertSafeIdpFetchUrl(discoveryUrl);
  return withSpan("convex-auth.connection.oidc.discovery", {}, async () => {
    return retryWithBackoff(
      async () => {
        const json = (await ctx.runAction(componentConnection.cache.oidcDiscovery, {
          url: discoveryUrl,
          runtimeOrigin,
          externalHost,
        })) as unknown;
        return validateOidcDiscovery(json);
      },
      { maxRetries: 2, baseMs: 200 },
    );
  });
}

function createGroupConnectionOidcFetch(
  config: Record<string, unknown>,
  discoveredIssuer?: string,
) {
  const { discovery } = getOidcSections(config);
  const runtimeOrigin =
    typeof discovery.discoveryUrl === "string" ? new URL(discovery.discoveryUrl).origin : undefined;
  const externalHost =
    typeof discovery.issuer === "string"
      ? new URL(discovery.issuer).host
      : typeof discoveredIssuer === "string"
        ? new URL(discoveredIssuer).host
        : undefined;

  return createGroupConnectionOidcFetchFromParts(runtimeOrigin, externalHost);
}

function createGroupConnectionOidcFetchFromParts(runtimeOrigin?: string, externalHost?: string) {
  return async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const rewrittenUrl =
      runtimeOrigin !== undefined && url.origin !== runtimeOrigin
        ? new URL(`${runtimeOrigin}${url.pathname}${url.search}`)
        : url;
    const headers = new Headers(init?.headers);
    if (runtimeOrigin !== undefined && externalHost !== undefined) {
      assertSafeIdpHost(externalHost);
      headers.set("host", externalHost);
    }
    assertSafeIdpFetchUrl(rewrittenUrl.toString());
    return await fetch(rewrittenUrl, { ...init, headers, redirect: "manual" });
  };
}

function normalizeOidcProfile(claims: Record<string, unknown>, mapping?: OIDCClaimMapping) {
  const getMapped = (key: string | undefined) =>
    typeof key === "string" ? claims[key] : undefined;
  return finalizeNormalizedProfile({
    id:
      (typeof getMapped(mapping?.subject) === "string"
        ? (getMapped(mapping?.subject) as string)
        : undefined) ?? (typeof claims.sub === "string" ? claims.sub : crypto.randomUUID()),
    email:
      (typeof getMapped(mapping?.email) === "string"
        ? (getMapped(mapping?.email) as string)
        : undefined) ?? (typeof claims.email === "string" ? claims.email : undefined),
    emailVerified:
      (typeof getMapped(mapping?.emailVerified) === "boolean"
        ? (getMapped(mapping?.emailVerified) as boolean)
        : undefined) ??
      (typeof claims.email_verified === "boolean" ? claims.email_verified : undefined),
    name:
      (typeof getMapped(mapping?.name) === "string"
        ? (getMapped(mapping?.name) as string)
        : undefined) ?? (typeof claims.name === "string" ? claims.name : undefined),
    image:
      (typeof getMapped(mapping?.image) === "string"
        ? (getMapped(mapping?.image) as string)
        : undefined) ?? (typeof claims.picture === "string" ? claims.picture : undefined),
    groups: normalizeStringArray(getMapped(mapping?.groups)),
    roles: normalizeStringArray(getMapped(mapping?.roles)),
  });
}

function getOidcJwks(
  url: string,
  runtimeOrigin?: string,
  externalHost?: string,
  fetchImpl?: ReturnType<typeof createGroupConnectionOidcFetch>,
) {
  const cacheKey = JSON.stringify({
    url,
    runtimeOrigin: fetchImpl ? runtimeOrigin : undefined,
    externalHost: fetchImpl ? externalHost : undefined,
  });
  return OIDC_JWKS_CACHE.get(cacheKey);
}

async function userInfoProfile(opts: {
  endpoint: string;
  accessToken: string;
  verifiedClaims: Record<string, unknown>;
  verifiedProfile: OAuthProfile & { emailVerified?: boolean };
  fetchImpl?: ReturnType<typeof createGroupConnectionOidcFetch>;
}): Promise<(OAuthProfile & { emailVerified?: boolean }) | null> {
  return withSpan("convex-auth.connection.oidc.userinfo", {}, async () => {
    let userInfo: OidcUserInfo;
    try {
      const response = await (opts.fetchImpl ?? fetch)(opts.endpoint, {
        headers: { Authorization: `Bearer ${opts.accessToken}` },
      });
      if (!response.ok) {
        throw new Error(`OIDC userinfo request failed: ${response.status}`);
      }
      userInfo = validateOidcUserInfo(await response.json());
    } catch {
      return null;
    }

    const userInfoSubject = typeof userInfo.sub === "string" ? userInfo.sub : undefined;
    const tokenSubject =
      typeof opts.verifiedClaims.sub === "string" ? opts.verifiedClaims.sub : undefined;
    if (
      userInfoSubject !== undefined &&
      tokenSubject !== undefined &&
      userInfoSubject !== tokenSubject
    ) {
      throw new Error("OIDC userinfo subject does not match ID token subject.");
    }

    return {
      id:
        userInfoSubject ??
        (typeof opts.verifiedClaims.sub === "string" ? opts.verifiedClaims.sub : undefined) ??
        crypto.randomUUID(),
      email: typeof userInfo.email === "string" ? userInfo.email : opts.verifiedProfile.email,
      emailVerified:
        typeof userInfo.email_verified === "boolean"
          ? userInfo.email_verified
          : opts.verifiedProfile.emailVerified,
      name: typeof userInfo.name === "string" ? userInfo.name : opts.verifiedProfile.name,
      image: typeof userInfo.picture === "string" ? userInfo.picture : opts.verifiedProfile.image,
      groups: normalizeStringArray(userInfo.groups) ?? opts.verifiedProfile.groups,
      roles: normalizeStringArray(userInfo.roles) ?? opts.verifiedProfile.roles,
    } as OAuthProfile & { emailVerified?: boolean };
  });
}

/**
 * Build the OIDC authorization-code provider and oauth config for a group
 * connection from its discovery document and stored config.
 *
 * The authorization URL always uses PKCE with `S256` and a nonce, and rejects
 * attempts to override reserved OAuth parameters. Token validation requires the
 * nonce, verifies the ID token against the JWKS (or the client secret for
 * advertised HS* algorithms), and enforces the audience, the issuer (against
 * the configured/discovered issuer set; exact match when `strictIssuer`), the
 * nonce, and `azp` when present. UserInfo results are rejected if their subject
 * disagrees with the ID token's.
 *
 * @see https://openid.net/specs/openid-connect-core-1_0.html
 * @internal
 */
export async function createGroupConnectionOidcProvider(
  ctx: GenericActionCtx<GenericDataModel>,
  componentConnection: AuthComponentApi["connection"],
  config: Record<string, unknown>,
  redirectUri: string,
) {
  const {
    discovery: discoveryConfig,
    client,
    request,
    security,
    profile,
  } = getOidcSections(config);
  const discovery: OidcDiscovery = await discoverOidcConfiguration(
    ctx,
    componentConnection,
    config,
  );
  const discoveredIssuer = normalizeOidcIssuer(discovery.issuer);
  const expectedIssuer =
    typeof discoveryConfig.issuer === "string"
      ? normalizeOidcIssuer(discoveryConfig.issuer)
      : discoveredIssuer;
  const strictIssuer = security.strictIssuer === true;
  if (typeof discoveryConfig.issuer === "string" && expectedIssuer !== discoveredIssuer) {
    if (strictIssuer) {
      throw new Error(
        `Configured OIDC issuer mismatch. configured=${expectedIssuer} discovery=${discoveredIssuer}`,
      );
    }
    log(
      "WARN",
      "Configured OIDC issuer differs from discovery issuer; accepting both for token verification.",
      {
        configuredIssuer: expectedIssuer,
        discoveryIssuer: discoveredIssuer,
      },
    );
  }
  const authorizationEndpoint = discovery.authorization_endpoint as string;
  const tokenEndpoint = discovery.token_endpoint as string;
  const jwksUri =
    typeof discoveryConfig.jwksUri === "string"
      ? discoveryConfig.jwksUri
      : typeof discovery.jwks_uri === "string"
        ? discovery.jwks_uri
        : "";
  const supportedIdTokenSigningAlgs = Array.isArray(discovery.id_token_signing_alg_values_supported)
    ? discovery.id_token_signing_alg_values_supported.filter(
        (value: unknown): value is string => typeof value === "string",
      )
    : [];
  const discoveredTokenEndpointAuthMethods = Array.isArray(
    discovery.token_endpoint_auth_methods_supported,
  )
    ? discovery.token_endpoint_auth_methods_supported.filter(
        (value: unknown): value is string => typeof value === "string",
      )
    : [];
  const tokenEndpointAuthMethod = resolveOidcAuthMethod(client, discoveredTokenEndpointAuthMethods);
  if (
    typeof client.authMethod === "string" &&
    discoveredTokenEndpointAuthMethods.length > 0 &&
    !discoveredTokenEndpointAuthMethods.includes(tokenEndpointAuthMethod)
  ) {
    throw new Error(
      `OIDC token endpoint auth method ${tokenEndpointAuthMethod} is not advertised by discovery.`,
    );
  }
  const userinfoEndpoint = (discovery.userinfo_endpoint as string | undefined) ?? undefined;
  const claimMapping =
    typeof profile.mapping === "object" && profile.mapping !== null
      ? (profile.mapping as OIDCClaimMapping)
      : undefined;
  const oidcFetch = createGroupConnectionOidcFetch(config, discovery.issuer as string);
  const runtimeOrigin =
    typeof discoveryConfig.discoveryUrl === "string"
      ? new URL(discoveryConfig.discoveryUrl).origin
      : undefined;
  const externalHost =
    typeof discoveryConfig.issuer === "string"
      ? new URL(discoveryConfig.issuer).host
      : typeof discovery.issuer === "string"
        ? new URL(discovery.issuer).host
        : undefined;
  const scopes = Array.isArray(request.scopes)
    ? request.scopes.filter((value: unknown): value is string => typeof value === "string")
    : ["openid", "profile", "email"];
  const expectedAudience: string | string[] = Array.isArray(discoveryConfig.audience)
    ? discoveryConfig.audience.filter(
        (value: unknown): value is string => typeof value === "string",
      )
    : typeof discoveryConfig.audience === "string"
      ? discoveryConfig.audience
      : String(client.id);
  const clockToleranceSeconds =
    typeof security.clockToleranceSeconds === "number" ? security.clockToleranceSeconds : 10;
  if (clockToleranceSeconds < 0 || clockToleranceSeconds > 300) {
    throw new Error("OIDC clockToleranceSeconds must be between 0 and 300.");
  }
  const expectedIssuers = strictIssuer
    ? [expectedIssuer]
    : Array.from(new Set([expectedIssuer, discoveredIssuer]));
  const jwks = getOidcJwks(jwksUri, runtimeOrigin, externalHost, oidcFetch);
  let verifiedClaims: Record<string, unknown> | null = null;
  let verifiedProfile: (OAuthProfile & { emailVerified?: boolean }) | null = null;
  const normalizeProfile = (claims: Record<string, unknown>) =>
    normalizeOidcProfile(claims, claimMapping);

  const provider = {
    pkce: "required" as const,
    createAuthorizationURL({
      state,
      codeVerifier,
      scopes: requestedScopes,
      nonce,
      loginHint,
    }: {
      state: string;
      codeVerifier?: string;
      scopes: string[];
      nonce?: string;
      loginHint?: string;
    }) {
      if (!codeVerifier) {
        throw new Error("OIDC PKCE requires a code verifier.");
      }
      const url = new URL(authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", String(client.id));
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set(
        "scope",
        (requestedScopes.length > 0 ? requestedScopes : scopes).join(" "),
      );
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set(
        "code_challenge",
        encodeBase64urlNoPadding(sha256(new TextEncoder().encode(codeVerifier))),
      );
      if (nonce !== undefined) {
        url.searchParams.set("nonce", nonce);
      }
      if (typeof loginHint === "string") {
        url.searchParams.set("login_hint", loginHint);
      }
      const authorizationParams =
        typeof request.authorizationParams === "object" && request.authorizationParams !== null
          ? (request.authorizationParams as Record<string, unknown>)
          : {};
      const reservedAuthorizationParams = new Set([
        "response_type",
        "client_id",
        "redirect_uri",
        "scope",
        "state",
        "code_challenge",
        "code_challenge_method",
        "nonce",
        "login_hint",
      ]);
      for (const [key, value] of Object.entries(authorizationParams)) {
        if (reservedAuthorizationParams.has(key)) {
          throw new Error(`OIDC authorizationParams cannot override reserved parameter: ${key}`);
        }
        if (typeof value === "string") {
          url.searchParams.set(key, value);
        }
      }
      return url;
    },
    async validateAuthorizationCode({
      code,
      codeVerifier,
    }: {
      code: string;
      codeVerifier?: string;
    }) {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      });
      const headers = new Headers({
        "Content-Type": "application/x-www-form-urlencoded",
      });
      if (typeof client.secret === "string" && tokenEndpointAuthMethod === "client_secret_basic") {
        const encodeCredential = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
        const credentials = `${encodeCredential(String(client.id))}:${encodeCredential(client.secret)}`;
        const basicAuth = encodeBase64(new TextEncoder().encode(credentials));
        headers.set("Authorization", `Basic ${basicAuth}`);
      } else {
        body.set("client_id", String(client.id));
        if (typeof client.secret === "string") {
          body.set("client_secret", client.secret);
        }
      }
      if (codeVerifier) {
        body.set("code_verifier", codeVerifier);
      }
      const response = await oidcFetch(tokenEndpoint, {
        method: "POST",
        headers,
        body,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `OIDC token exchange failed: ${response.status}${detail ? ` ${detail}` : ""}`,
        );
      }
      const data = (await response.json()) as Record<string, unknown>;
      return normalizeOAuthTokenResponse(data);
    },
  };

  const oauthConfig = {
    scopes,
    nonce: true,
    validateTokens: async (tokens: OAuthTokens, ctx: { nonce?: string }) => {
      if (ctx.nonce === undefined) {
        throw new Error("OIDC nonce is required.");
      }

      const idToken = tokens.idToken;
      if (idToken === undefined) {
        throw new Error("OIDC response is missing id_token.");
      }
      const verifiedIdToken = idToken;
      const protectedHeader = decodeProtectedHeader(verifiedIdToken);
      const tokenAlg = protectedHeader.alg;
      const useSymmetricValidation =
        typeof tokenAlg === "string" &&
        (tokenAlg === "HS256" || tokenAlg === "HS384" || tokenAlg === "HS512") &&
        supportedIdTokenSigningAlgs.includes(tokenAlg);

      const verificationOptions: JWTVerifyOptions = {
        audience: expectedAudience,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
        clockTolerance: clockToleranceSeconds,
      };

      let verification;
      try {
        verification = await (useSymmetricValidation
          ? jwtVerify(
              verifiedIdToken,
              (() => {
                if (typeof client.secret !== "string") {
                  throw new Error(
                    "OIDC provider uses symmetric ID token signatures but clientSecret is missing.",
                  );
                }
                return new TextEncoder().encode(client.secret);
              })(),
              verificationOptions,
            )
          : jwtVerify(verifiedIdToken, jwks as JWTVerifyGetKey, verificationOptions));
      } catch (error) {
        throw asError(error);
      }

      const payload = verification.payload as Record<string, unknown>;
      const tokenIssuerRaw = typeof payload.iss === "string" ? payload.iss : undefined;
      const tokenIssuer =
        typeof tokenIssuerRaw === "string" ? tokenIssuerRaw.replace(/\/$/, "") : undefined;

      if (!tokenIssuer || !expectedIssuers.includes(tokenIssuer)) {
        throw new Error(
          `OIDC token issuer mismatch. Received: ${tokenIssuer ?? "<missing>"}. Expected one of: ${expectedIssuers.join(", ")}`,
        );
      }

      if (payload.nonce !== ctx.nonce) {
        throw new Error("OIDC nonce mismatch.");
      }

      if (payload.azp !== undefined && payload.azp !== String(client.id)) {
        throw new Error("OIDC authorized party does not match client ID.");
      }

      verifiedClaims = payload;
      verifiedProfile = normalizeProfile(payload);
    },
    accountLinking: config.accountLinking,
    profile: async (tokens: OAuthTokens): Promise<OAuthProfile> => {
      if (verifiedProfile === null || verifiedClaims === null) {
        throw new Error("OIDC profile requested before the id_token was verified.");
      }
      if (userinfoEndpoint && typeof tokens.accessToken === "string") {
        const resolvedProfile = await userInfoProfile({
          endpoint: userinfoEndpoint,
          accessToken: tokens.accessToken,
          verifiedClaims,
          verifiedProfile,
          fetchImpl: oidcFetch,
        });
        if (resolvedProfile !== null) {
          return resolvedProfile;
        }
      }
      return verifiedProfile;
    },
  } as const;

  return { provider, oauthConfig };
}

/**
 * Build a minimal {@link OAuthMaterializedConfig} (no runtime provider) for a
 * group connection, used where only the provider id and account-linking mode
 * are needed.
 * @internal
 */
export function createSyntheticOAuthMaterializedConfig(
  providerId: string,
  options?: {
    accountLinking?: OAuthMaterializedConfig["accountLinking"];
  },
): OAuthMaterializedConfig {
  return {
    id: providerId,
    type: "oauth",
    provider: null,
    scopes: [],
    accountLinking: options?.accountLinking ?? "sameConnection",
  };
}

/**
 * Assemble the per-request OIDC runtime for a group connection: its provider
 * id, the configured provider and oauth config, and the group OIDC URLs.
 * @internal
 */
export async function createGroupConnectionOidcRuntime(opts: {
  ctx: GenericActionCtx<GenericDataModel>;
  componentConnection: AuthComponentApi["connection"];
  rootUrl: string;
  connectionId: string;
  oidc: Record<string, unknown>;
  sharedRedirectURI?: string;
}) {
  const providerId = groupOidcProviderId(opts.connectionId);
  const urls = getGroupOidcUrls({
    rootUrl: opts.rootUrl,
    connectionId: opts.connectionId,
    sharedRedirectURI: opts.sharedRedirectURI,
  });
  const { provider, oauthConfig } = await createGroupConnectionOidcProvider(
    opts.ctx,
    opts.componentConnection,
    opts.oidc,
    urls.callbackUrl,
  );
  return {
    oidc: opts.oidc,
    providerId,
    provider,
    oauthConfig,
    ...urls,
  };
}
