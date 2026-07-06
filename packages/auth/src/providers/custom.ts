/**
 * Custom OAuth provider.
 *
 * Use this as an escape hatch for OAuth providers that do not have a first-
 * party wrapper yet.
 *
 * @module
 */

import { sha256 } from "@oslojs/crypto/sha2";
import { encodeBase64urlNoPadding } from "@oslojs/encoding";

import { createOAuthProvider } from "../server/oauth/factory";
import { normalizeOAuthTokenResponse } from "../server/oauth/normalize";
import type { OAuthProfile, OAuthRuntimeClient, OAuthTokens } from "../server/types";
import { defaultOAuthRedirectUri } from "./redirect";

type ScopeSeparator = " " | ",";
type PkceMode = "required" | "optional" | "never";
type TokenAuthMethod = "basic" | "body" | "none";

/** Configuration for the custom provider authorization URL. */
export interface CustomOAuthAuthorizationConfig {
  /** Authorization endpoint URL. */
  url: string;
  /** PKCE requirement for this provider's authorization flow. */
  pkce?: PkceMode;
  /** Query parameter name used for the client ID. */
  clientIdParam?: string;
  /** Query parameter name used for scopes. */
  scopeParam?: string;
  /** Separator used when joining multiple scopes. */
  scopeSeparator?: ScopeSeparator;
  /** Additional query parameters appended to the authorization URL. */
  extraParams?: Record<string, string>;
}

/** Configuration for the custom provider token exchange request. */
export interface CustomOAuthTokenConfig {
  /** Token endpoint URL. */
  url: string;
  /** How client credentials are sent to the token endpoint. */
  authMethod?: TokenAuthMethod;
  /** Form field name used for the client ID. */
  clientIdParam?: string;
  /** Form field name used for the client secret. */
  clientSecretParam?: string;
  /** Form field name used for the PKCE code verifier. */
  codeVerifierParam?: string;
  /** Form field name used for scopes. */
  scopeParam?: string;
  /** Separator used when joining multiple scopes. */
  scopeSeparator?: ScopeSeparator;
  /** Whether to include the redirect URI in token requests. */
  includeRedirectUri?: boolean;
  /** Whether to include configured scopes in token requests. */
  includeScopes?: boolean;
  /** Additional form parameters appended to token requests. */
  extraParams?: Record<string, string>;
}

/** Configuration for the {@link custom} provider. */
export interface CustomOAuthConfig {
  /** Stable provider identifier used in `signIn("<id>")`. */
  id: string;
  /** OAuth client identifier. */
  clientId: string;
  /** Optional OAuth client secret. */
  clientSecret?: string | null;
  /** Optional callback URL override. Defaults to the auth site URL plus `/callback/<id>`. */
  redirectUri?: string;
  /** Optional default scopes requested during sign-in. */
  scopes?: string[];
  /** Account-linking strategy for existing users with matching email addresses. */
  accountLinking?: "verifiedEmail" | "none";
  /** On returning sign-in, refresh `User.name`/`image`/`email` from the new profile. Defaults to `true`. */
  updateProfileOnLogin?: boolean;
  /** Whether the provider requires nonce generation and validation. */
  nonce?: boolean;
  /** Authorization endpoint configuration. */
  authorization: CustomOAuthAuthorizationConfig;
  /** Token exchange endpoint configuration. */
  token: CustomOAuthTokenConfig;
  /** Optional profile loader that converts OAuth tokens into a normalized profile. */
  profile?: (tokens: OAuthTokens) => Promise<OAuthProfile>;
  /** Optional token validation hook for provider-specific checks. */
  validateTokens?: (tokens: OAuthTokens, ctx: { nonce?: string }) => Promise<void>;
}

function joinScopes(scopes: string[], separator: ScopeSeparator = " ") {
  return scopes.join(separator);
}

function createCodeChallenge(codeVerifier: string) {
  return encodeBase64urlNoPadding(sha256(new TextEncoder().encode(codeVerifier)));
}

function createRuntimeClient(config: CustomOAuthConfig): OAuthRuntimeClient {
  const authorization = config.authorization;
  const token = config.token;
  const pkce = authorization.pkce ?? "required";
  const scopes = [...(config.scopes ?? [])];
  const getRedirectUri = (redirectUri?: string) =>
    config.redirectUri ?? defaultOAuthRedirectUri(config.id, redirectUri);

  return {
    pkce,
    createAuthorizationURL({
      state,
      codeVerifier,
      scopes: requestedScopes,
      nonce,
      redirectUri: runtimeRedirectUri,
    }) {
      const redirectUri = getRedirectUri(runtimeRedirectUri);
      const url = new URL(authorization.url);
      const nextScopes = requestedScopes.length > 0 ? requestedScopes : scopes;
      url.searchParams.set("response_type", "code");
      url.searchParams.set(authorization.clientIdParam ?? "client_id", config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      if (nextScopes.length > 0) {
        url.searchParams.set(
          authorization.scopeParam ?? "scope",
          joinScopes(nextScopes, authorization.scopeSeparator),
        );
      }
      if (codeVerifier !== undefined && pkce !== "never") {
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("code_challenge", createCodeChallenge(codeVerifier));
      }
      if (nonce !== undefined) {
        url.searchParams.set("nonce", nonce);
      }
      for (const [key, value] of Object.entries(authorization.extraParams ?? {})) {
        url.searchParams.set(key, value);
      }
      return url;
    },
    async validateAuthorizationCode({ code, codeVerifier, redirectUri: runtimeRedirectUri }) {
      const redirectUri = getRedirectUri(runtimeRedirectUri);
      const body = new URLSearchParams();
      body.set("grant_type", "authorization_code");
      body.set("code", code);
      if (token.includeRedirectUri ?? true) {
        body.set("redirect_uri", redirectUri);
      }
      if (pkce !== "never" && codeVerifier !== undefined) {
        body.set(token.codeVerifierParam ?? "code_verifier", codeVerifier);
      }
      if (token.includeScopes === true && scopes.length > 0) {
        body.set(
          token.scopeParam ?? "scope",
          joinScopes(scopes, token.scopeSeparator ?? authorization.scopeSeparator),
        );
      }
      if (token.authMethod !== "basic") {
        body.set(token.clientIdParam ?? "client_id", config.clientId);
      }
      if (token.authMethod !== "basic" && token.authMethod !== "none" && config.clientSecret) {
        body.set(token.clientSecretParam ?? "client_secret", config.clientSecret);
      }
      for (const [key, value] of Object.entries(token.extraParams ?? {})) {
        body.set(key, value);
      }

      const headers = new Headers({
        "Content-Type": "application/x-www-form-urlencoded",
      });
      if (token.authMethod === "basic") {
        if (!config.clientSecret) {
          throw new Error(
            `OAuth provider "${config.id}" requires clientSecret for token.authMethod="basic".`,
          );
        }
        const credentials = btoa(`${config.clientId}:${config.clientSecret}`);
        headers.set("Authorization", `Basic ${credentials}`);
      }

      const response = await fetch(token.url, {
        method: "POST",
        headers,
        body,
      });
      if (!response.ok) {
        throw new Error(`OAuth token exchange failed: ${response.status}`);
      }

      const raw = (await response.json()) as Record<string, unknown>;
      return normalizeOAuthTokenResponse(raw);
    },
  };
}

/**
 * Create a custom OAuth provider.
 *
 * @param config - OAuth endpoints, credentials, and profile callbacks.
 * @returns A configured OAuth provider for `defineAuth`.
 *
 * @example
 * ```ts
 * import { custom } from "@robelest/convex-auth/providers";
 *
 * custom({
 *   id: "workos",
 *   clientId: env.WORKOS_CLIENT_ID!,
 *   clientSecret: env.WORKOS_CLIENT_SECRET!,
 *   authorization: { url: "https://api.workos.com/connection/authorize" },
 *   token: { url: "https://api.workos.com/connection/token", authMethod: "basic" },
 * })
 * ```
 */
export function custom(config: CustomOAuthConfig) {
  return createOAuthProvider({
    id: config.id,
    provider: createRuntimeClient(config),
    scopes: config.scopes ?? [],
    profile: config.profile,
    nonce: config.nonce,
    validateTokens: config.validateTokens,
    accountLinking: config.accountLinking,
    updateProfileOnLogin: config.updateProfileOnLogin,
  });
}
