/**
 * OAuth flow implementation.
 *
 * Uses convex-auth's internal runtime contract for provider integration.
 *
 * @internal
 * @module
 */

import * as arctic from "arctic";
import { ConvexError as ConvexErrorCtor } from "convex/values";

import { ErrorCode } from "../../shared/codes";
import { constantTimeEqualHex as constantTimeEqual } from "../../shared/compare";
import { SHARED_COOKIE_OPTIONS } from "../cookies";
import { envOptionalString, readConfigSync } from "../env";
import { log } from "../log";
import type { OAuthProfile, OAuthRuntimeClient, OAuthTokens } from "../types";
import { isLocalHost } from "../url";
import { withSpan } from "../utils/span";

type OAuthErrorData = {
  code: string;
  message: string;
  cause?: string;
};

type OAuthProviderConfigLike = {
  scopes?: string[];
  provider: OAuthRuntimeClient | null;
  profile?: (tokens: OAuthTokens) => Promise<OAuthProfile>;
  nonce?: boolean;
  validateTokens?: (tokens: OAuthTokens, ctx: { nonce?: string }) => Promise<void>;
};

function failConvex(data: OAuthErrorData): never {
  throw new ConvexErrorCtor(data);
}

async function tryConvex<A>(options: {
  try: () => Promise<A> | A;
  catch: (error: unknown) => OAuthErrorData;
}): Promise<A> {
  try {
    return await options.try();
  } catch (error) {
    throw new ConvexErrorCtor(options.catch(error));
  }
}

/**
 * A cookie to be set on the HTTP response.
 * @internal
 */
export interface OAuthCookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

/**
 * Result of creating an authorization URL.
 * @internal
 */
export interface AuthorizationResult {
  redirect: string;
  cookies: OAuthCookie[];
  signature: string;
}

/**
 * Result of handling an OAuth callback.
 * @internal
 */
export interface CallbackResult {
  profile: OAuthProfile;
  providerAccountId: string;
  cookies: OAuthCookie[];
  signature: string;
}

const COOKIE_TTL = 60 * 15;
const convexSiteUrl = readConfigSync(envOptionalString("CONVEX_SITE_URL"));
const oauthCookiePrefix = !isLocalHost(convexSiteUrl ?? undefined) ? "__Host-" : "";

function oauthCookieName(type: "state" | "pkce" | "nonce", providerId: string) {
  return oauthCookiePrefix + providerId + "OAuth" + type;
}

function createCookie(
  type: "state" | "pkce" | "nonce",
  providerId: string,
  value: string,
): OAuthCookie {
  const expires = new Date();
  expires.setTime(expires.getTime() + COOKIE_TTL * 1000);
  return {
    name: oauthCookieName(type, providerId),
    value,
    options: { ...SHARED_COOKIE_OPTIONS, expires },
  };
}

function clearCookie(type: "state" | "pkce" | "nonce", providerId: string): OAuthCookie {
  return {
    name: oauthCookieName(type, providerId),
    value: "",
    options: { ...SHARED_COOKIE_OPTIONS, maxAge: 0 },
  };
}

/**
 * Creates a signature string from the OAuth state parameters.
 * This is stored in the verifier table and validated during callback.
 */
function getAuthorizationSignature({
  codeVerifier,
  state,
}: {
  codeVerifier?: string;
  state?: string;
}) {
  return [codeVerifier, state].filter((param) => param !== undefined).join(" ");
}

function requiresPKCE(provider: OAuthRuntimeClient) {
  return provider.pkce === "required" || provider.pkce === "optional";
}

async function exchangeCode(
  provider: OAuthRuntimeClient,
  code: string,
  codeVerifier: string | undefined,
  redirectUri: string | undefined,
): Promise<OAuthTokens> {
  return tryConvex({
    try: () => provider.validateAuthorizationCode({ code, codeVerifier, redirectUri }),
    catch: (error) => {
      if (error instanceof arctic.OAuth2RequestError) {
        console.error("[auth] OAuth token exchange rejected by provider", {
          providerCode: error.code,
          description: error.description,
        });
        return {
          code: ErrorCode.OAUTH_PROVIDER_ERROR,
          message: "The identity provider rejected the token exchange.",
        };
      }
      if (error instanceof arctic.ArcticFetchError) {
        console.error("[auth] Network error during OAuth token exchange", {
          message: error.message,
        });
        return {
          code: ErrorCode.OAUTH_PROVIDER_ERROR,
          message: "Could not reach the identity provider.",
        };
      }
      console.error("[auth] Unexpected OAuth token-exchange error", { error });
      return {
        code: ErrorCode.OAUTH_PROVIDER_ERROR,
        message: "Token exchange failed.",
      };
    },
  });
}

/**
 * Read an OIDC `email_verified` claim as a tri-state signal.
 *
 * Per OpenID Connect the claim is a JSON boolean, but some IdPs encode it as
 * the string `"true"` / `"false"`. Only an explicit positive value resolves to
 * `true`; an explicit negative resolves to `false`; anything else — most
 * importantly an ABSENT claim — resolves to `undefined`. Downstream account
 * linking (`server/user/account.ts`) treats only `true` as verified, so never
 * fabricating a positive here is what stops an IdP that omits the claim from
 * driving email-based account takeover (nOAuth class).
 */
function readEmailVerifiedClaim(claim: unknown): boolean | undefined {
  if (claim === true || claim === "true") {
    return true;
  }
  if (claim === false || claim === "false") {
    return false;
  }
  return undefined;
}

async function extractProfile(
  providerId: string,
  oauthConfig: OAuthProviderConfigLike,
  tokens: OAuthTokens,
): Promise<OAuthProfile> {
  if (oauthConfig.profile) {
    return tryConvex({
      try: () => oauthConfig.profile!(tokens),
      catch: (error) => ({
        code: ErrorCode.OAUTH_INVALID_PROFILE,
        message: `Profile callback threw: ${error instanceof Error ? error.message : String(error)}`,
      }),
    });
  }

  if (typeof tokens.idToken === "string") {
    const claims = arctic.decodeIdToken(tokens.idToken) as Record<string, unknown>;
    return {
      id: (claims.sub as string) ?? crypto.randomUUID(),
      name: (claims.name as string) ?? undefined,
      email: (claims.email as string) ?? undefined,
      image: (claims.picture as string) ?? undefined,
      emailVerified: readEmailVerifiedClaim(claims.email_verified),
    };
  }

  return failConvex({
    code: ErrorCode.OAUTH_INVALID_PROFILE,
    message:
      `Provider "${providerId}" does not return an ID token. ` +
      "Configure a profile extractor for this provider to derive user info from the access token.",
  });
}

function validateProfileId(providerId: string, profile: OAuthProfile): OAuthProfile {
  if (typeof profile.id === "string" && profile.id) {
    return profile;
  }
  return failConvex({
    code: ErrorCode.OAUTH_INVALID_PROFILE,
    message: `The profile callback for "${providerId}" must return an object with a string \`id\` field.`,
  });
}

/**
 * Create an OAuth authorization URL using the configured runtime client.
 *
 * Generates `state` (optionally transformed) and, when the provider requires
 * PKCE, a code verifier; the verifier, state, and any nonce are returned as
 * cookies to be checked on callback. The returned `signature` binds the
 * verifier and state for later verification.
 */
export async function createOAuthAuthorizationURL(
  providerId: string,
  oauthConfig: OAuthProviderConfigLike,
  options?: {
    loginHint?: string;
    redirectUri?: string;
    stateTransform?: (state: string) => string;
  },
): Promise<AuthorizationResult> {
  if (oauthConfig.provider === null) {
    throw new Error(`OAuth provider "${providerId}" is missing a runtime client.`);
  }
  const rawState = arctic.generateState();
  const state = options?.stateTransform ? options.stateTransform(rawState) : rawState;
  const cookies: OAuthCookie[] = [];
  let codeVerifier: string | undefined;

  const scopes = oauthConfig.scopes ?? [];

  if (requiresPKCE(oauthConfig.provider)) {
    codeVerifier = arctic.generateCodeVerifier();
    cookies.push(createCookie("pkce", providerId, codeVerifier));
  }

  cookies.push(createCookie("state", providerId, state));

  let nonce: string | undefined;
  if (oauthConfig.nonce === true) {
    nonce = arctic.generateState();
    cookies.push(createCookie("nonce", providerId, nonce));
  }

  const url = oauthConfig.provider.createAuthorizationURL({
    state,
    codeVerifier,
    scopes,
    nonce,
    loginHint: options?.loginHint,
    redirectUri: options?.redirectUri,
  });

  log("DEBUG", "OAuth authorization URL created", {
    url: url.toString(),
    providerId,
    hasPKCE: !!codeVerifier,
  });

  const signature = getAuthorizationSignature({ codeVerifier, state });

  return {
    redirect: url.toString(),
    cookies,
    signature,
  };
}

/**
 * Handle the OAuth callback: constant-time compare the returned `state`
 * against the stored cookie, exchange the code for tokens (replaying the PKCE
 * verifier and requiring the nonce cookie when used), run any provider token
 * validation, then extract and validate the profile. State/PKCE/nonce cookies
 * are cleared on the response.
 */
export async function handleOAuthCallback(
  providerId: string,
  oauthConfig: OAuthProviderConfigLike,
  params: Record<string, string>,
  cookies: Record<string, string | undefined>,
  options?: { redirectUri?: string },
): Promise<CallbackResult> {
  return withSpan("convex-auth.oauth.callback", { providerId }, async () => {
    if (oauthConfig.provider === null) {
      return failConvex({
        code: ErrorCode.OAUTH_PROVIDER_ERROR,
        message: `OAuth provider "${providerId}" is missing a runtime client.`,
      });
    }

    const responseCookies: OAuthCookie[] = [];
    const stateCookieName = oauthCookieName("state", providerId);
    const storedState = cookies[stateCookieName];
    const returnedState = params.state;

    if (!storedState || !returnedState || !constantTimeEqual(storedState, returnedState)) {
      return failConvex({
        code: ErrorCode.OAUTH_INVALID_STATE,
        message: "Invalid OAuth state. Please try signing in again.",
      });
    }
    responseCookies.push(clearCookie("state", providerId));

    if (params.error) {
      const cause = {
        providerId,
        error: params.error,
        error_description: params.error_description,
      };
      log("DEBUG", "OAuthCallbackError", cause);
      return failConvex({
        code: ErrorCode.OAUTH_PROVIDER_ERROR,
        message: "OAuth provider returned an error",
        cause: JSON.stringify(cause),
      });
    }

    const code = params.code;
    if (code == null) {
      return failConvex({
        code: ErrorCode.OAUTH_PROVIDER_ERROR,
        message: "Missing authorization code in callback",
      });
    }

    let codeVerifier: string | undefined;
    if (requiresPKCE(oauthConfig.provider)) {
      const pkceCookieName = oauthCookieName("pkce", providerId);
      const storedVerifier = cookies[pkceCookieName];
      if (storedVerifier == null) {
        return failConvex({
          code: ErrorCode.OAUTH_MISSING_VERIFIER,
          message: "Missing PKCE verifier cookie for OAuth callback",
        });
      }
      codeVerifier = storedVerifier;
      responseCookies.push(clearCookie("pkce", providerId));
    }

    let nonce: string | undefined;
    if (oauthConfig.nonce === true) {
      const nonceCookieName = oauthCookieName("nonce", providerId);
      const storedNonce = cookies[nonceCookieName];
      if (storedNonce == null) {
        return failConvex({
          code: ErrorCode.OAUTH_PROVIDER_ERROR,
          message: "Missing nonce cookie for OAuth callback",
        });
      }
      nonce = storedNonce;
      responseCookies.push(clearCookie("nonce", providerId));
    }

    const tokens = await exchangeCode(
      oauthConfig.provider,
      code,
      codeVerifier,
      options?.redirectUri,
    );

    if (oauthConfig.validateTokens !== undefined) {
      await tryConvex({
        try: () => oauthConfig.validateTokens!(tokens, { nonce }),
        catch: (error) => ({
          code: ErrorCode.OAUTH_PROVIDER_ERROR,
          message: `Token validation failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      });
    }

    const rawProfile = await extractProfile(providerId, oauthConfig, tokens);
    const profile = validateProfileId(providerId, rawProfile);

    log("DEBUG", "OAuth callback profile extracted", {
      providerId,
      profileId: profile.id,
    });

    const signature = getAuthorizationSignature({
      codeVerifier,
      state: storedState,
    });

    return {
      profile,
      providerAccountId: profile.id,
      cookies: responseCookies,
      signature,
    };
  });
}
