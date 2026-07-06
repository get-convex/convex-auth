/**
 * Microsoft OAuth provider.
 *
 * ```ts
 * import { microsoft } from "@robelest/convex-auth/providers/microsoft";
 *
 * microsoft({
 *   tenant: env.AUTH_MICROSOFT_TENANT_ID!,
 *   clientId: env.AUTH_MICROSOFT_ID!,
 *   clientSecret: env.AUTH_MICROSOFT_SECRET!,
 * })
 * ```
 *
 * @module
 */

import { MicrosoftEntraId } from "arctic";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";

import { createArcticOAuthClient, createOAuthProvider } from "../server/oauth/factory";
import { defaultOAuthRedirectUri } from "./redirect";

const DEFAULT_SCOPES = ["openid", "profile", "email"];

/** Configuration for the {@link microsoft} provider. */
export interface MicrosoftConfig {
  /** Microsoft Entra tenant ID or domain used to scope the OAuth issuer. */
  tenant: string;
  /** OAuth client ID from Microsoft Entra ID. */
  clientId: string;
  /** OAuth client secret for confidential clients, when required. */
  clientSecret?: string | null;
  /** Optional callback URL override. Defaults to the auth site URL plus `/callback/microsoft`. */
  redirectUri?: string;
  /** Optional OAuth scopes. Defaults to `openid profile email`. */
  scopes?: string[];
  /** Account-linking strategy for existing users with matching email addresses. */
  accountLinking?: "verifiedEmail" | "none";
  /** On returning sign-in, refresh `User.name`/`image`/`email` from the new profile. Defaults to `true`. */
  updateProfileOnLogin?: boolean;
}

/**
 * Create a Microsoft OAuth provider.
 *
 * This wrapper enables nonce handling and validates the returned ID token.
 *
 * @param config - Microsoft Entra ID client settings.
 * @returns A configured Microsoft OAuth provider for `defineAuth`.
 * @throws {Error} When no callback URL can be derived and `redirectUri` is omitted.
 *
 * @example
 * ```ts
 * import { microsoft } from "@robelest/convex-auth/providers/microsoft";
 *
 * microsoft({
 *   tenant: env.AUTH_MICROSOFT_TENANT_ID!,
 *   clientId: env.AUTH_MICROSOFT_ID!,
 *   clientSecret: env.AUTH_MICROSOFT_SECRET!,
 * })
 * ```
 */
export function microsoft(config: MicrosoftConfig) {
  const scopes = config.scopes ?? DEFAULT_SCOPES;
  const createProvider = (redirectUri?: string) =>
    new MicrosoftEntraId(
      config.tenant,
      config.clientId,
      config.clientSecret ?? null,
      config.redirectUri ?? defaultOAuthRedirectUri("microsoft", redirectUri),
    );
  const issuer = `https://login.microsoftonline.com/${config.tenant}/v2.0`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/discovery/v2.0/keys`));

  return createOAuthProvider({
    id: "microsoft",
    provider: createArcticOAuthClient(createProvider, { pkce: "required" }),
    scopes,
    nonce: true,
    accountLinking: config.accountLinking,
    updateProfileOnLogin: config.updateProfileOnLogin,
    validateTokens: async (tokens, ctx) => {
      if (!ctx.nonce) {
        throw new Error("Microsoft OAuth requires a nonce.");
      }
      if (!tokens.idToken) {
        throw new Error("Microsoft OAuth response is missing id_token.");
      }

      const idToken = tokens.idToken;
      const protectedHeader = decodeProtectedHeader(idToken);
      const tokenAlg = protectedHeader.alg;
      const usesSymmetricAlg = tokenAlg === "HS256" || tokenAlg === "HS384" || tokenAlg === "HS512";

      const verification = await (usesSymmetricAlg
        ? jwtVerify(
            idToken,
            (() => {
              if (!config.clientSecret) {
                throw new Error(
                  "Microsoft token uses symmetric signatures but clientSecret is missing.",
                );
              }
              return new TextEncoder().encode(config.clientSecret);
            })(),
            {
              issuer,
              audience: config.clientId,
              requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
              clockTolerance: 10,
            },
          )
        : jwtVerify(idToken, jwks, {
            issuer,
            audience: config.clientId,
            requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
            clockTolerance: 10,
          }));

      if (verification.payload.nonce !== ctx.nonce) {
        throw new Error("Microsoft OAuth nonce mismatch.");
      }

      if (
        Array.isArray(verification.payload.aud) &&
        verification.payload.aud.length > 1 &&
        verification.payload.azp !== config.clientId
      ) {
        throw new Error("Microsoft OAuth authorized party does not match client ID.");
      }
    },
  });
}
