import { CookieOption, CookiesOptions } from "@auth/core/types.js";
import { requireEnv } from "../utils.js";
import { InternalProvider } from "./types.js";
import { SHARED_COOKIE_OPTIONS } from "../cookies.js";
import { fetchOpt } from "./lib/utils/customFetch.js";
import * as o from "oauth4webapi";
import { normalizeEndpoint } from "../provider_utils.js";
import { isLocalHost } from "../utils.js";
import { OAuthConfig } from "@auth/core/providers/oauth.js";

// ConvexAuth: The logic for the callback URL is different from Auth.js
export function callbackUrl(providerId: string) {
  return (process.env.CUSTOM_AUTH_SITE_URL ?? requireEnv("CONVEX_SITE_URL")) + "/api/auth/callback/" + providerId;
}

// ConvexAuth: This is a ConvexAuth specific function that produces a string that the
// Convex functions will validate
export function getAuthorizationSignature({
  codeVerifier,
  state,
  nonce,
}: {
  codeVerifier?: string;
  state?: string;
  nonce?: string;
}) {
  return [codeVerifier, state, nonce]
    .filter((param) => param !== undefined)
    .join(" ");
}

function oauthStateCookieName(
  type: "state" | "pkce" | "nonce",
  providerId: string,
) {
  return (!isLocalHost(process.env.CONVEX_SITE_URL) ? "__Host-" : "") + providerId + "OAuth" + type;
}

export const defaultCookiesOptions: (
  providerId: string,
) => Record<keyof CookiesOptions, CookieOption> = (providerId) => {
  return {
    pkceCodeVerifier: {
      name: oauthStateCookieName("pkce", providerId),
      options: {
        ...SHARED_COOKIE_OPTIONS,
      },
    },
    state: {
      name: oauthStateCookieName("state", providerId),
      options: {
        ...SHARED_COOKIE_OPTIONS,
      },
    },
    nonce: {
      name: oauthStateCookieName("nonce", providerId),
      options: {
        ...SHARED_COOKIE_OPTIONS,
      },
    },
    // ConvexAuth: We don't support webauthn, so this value doesn't actually matter
    webauthnChallenge: {
      name: "ConvexAuth_shouldNotBeUsed_webauthnChallenge",
      options: {
        ...SHARED_COOKIE_OPTIONS,
      },
    },
    // ConvexAuth: We don't use these cookies, so their values should never be used
    sessionToken: {
      name: "ConvexAuth_shouldNotBeUsed_sessionToken",
      options: {
        ...SHARED_COOKIE_OPTIONS,
      },
    },
    callbackUrl: {
      name: "ConvexAuth_shouldNotBeUsed_callbackUrl",
      options: {
        ...SHARED_COOKIE_OPTIONS,
      },
    },
    csrfToken: {
      name: "ConvexAuth_shouldNotBeUsed_csrfToken",
      options: {
        ...SHARED_COOKIE_OPTIONS,
      },
    },
  };
};

// Microsoft multi-tenant: aliases like "common", "organizations", "consumers"
// discover issuer .../{alias}/v2.0 but tokens carry tenant-specific
// iss claims (.../{tenantId}/v2.0).
//
// oauth4webapi's processDiscoveryResponse validates that the ID token's
// iss matches the discovered issuer, which fails for these aliases.
// The library exports a _expectedIssuer Symbol as an extension point
// specifically for this case — setting it to a function replaces the
// default strict-equal check with custom validation. This is the same
// approach used by @auth/core internally for Microsoft providers:
//   https://github.com/nextauthjs/next-auth/blob/main/packages/core/src/lib/actions/callback/oauth/callback.ts
//
// The symbol is exported at runtime but not in the type declarations.
// Only needed for multi-tenant aliases; tenant-specific endpoints
// return exact issuer matches.
function applyMultiTenantEntraFix(
  as: o.AuthorizationServer,
  config: OAuthConfig<any>,
) {
  const issuer = (as as any).issuer ?? as.issuer ?? "";
  const isMultiTenantEntra =
    config.type === "oidc" &&
    config.id === "microsoft-entra-id" &&
    /\/(common|organizations|consumers)\/v2\.0\/?$/.test(issuer);
  if (isMultiTenantEntra) {
    const expectedIssuer = (o as any)._expectedIssuer as symbol;
    (as as any)[expectedIssuer] = (result: any) => result.claims.iss;
  }
}

export async function oAuthConfigToInternalProvider(config: OAuthConfig<any>): Promise<InternalProvider<"oauth" | "oidc">> {
  // Only do service discovery if the provider does not have the required configuration
  if (!config.authorization || !config.token || !config.userinfo) {
    // Taken from https://github.com/nextauthjs/next-auth/blob/a7491dcb9355ff2d01fb8e9236636605e2090145/packages/core/src/lib/actions/callback/oauth/callback.ts#L63
    if (!config.issuer) {
      throw new Error(
        `Provider \`${config.id}\` is missing an \`issuer\` URL configuration. Consult the provider docs.`,
      );
    }

    const issuer = new URL(config.issuer);
    // TODO: move away from allowing insecure HTTP requests
    const discoveryResponse = await o.discoveryRequest(issuer, {
      ...fetchOpt(config),
      [o.allowInsecureRequests]: true,
    });
    const discoveredAs = await o.processDiscoveryResponse(
      issuer,
      discoveryResponse,
    );

    if (!discoveredAs.token_endpoint)
      throw new TypeError(
        "TODO: Authorization server did not provide a token endpoint.",
      );

    applyMultiTenantEntraFix(discoveredAs, config);

    const as: o.AuthorizationServer = discoveredAs;
    return {
      ...config,
      checks: config.checks!,
      profile: config.profile!,
      account: config.account!,
      clientId: config.clientId!,
      idToken: config.type === "oidc" ? config.idToken : undefined,
      // ConvexAuth: Apparently it's important for us to normalize the endpoint after
      // service discovery (https://github.com/get-convex/convex-auth/commit/35bf716bfb0d29dbce1cbca318973b0732f75015)
      authorization: normalizeEndpoint({
        ...config.authorization,
        url: as.authorization_endpoint,
      }),
      token: normalizeEndpoint({
        ...config.token,
        url: as.token_endpoint,
      }),
      userinfo: as.userinfo_endpoint
        ? normalizeEndpoint({
            ...config.userinfo,
            url: as.userinfo_endpoint,
          })
        : config.userinfo,
      as,
      configSource: "discovered"
    };
  }

  const authorization = normalizeEndpoint(config.authorization);
  const token = normalizeEndpoint(config.token);
  const userinfo = config.userinfo
    ? normalizeEndpoint(config.userinfo)
    : undefined;
  const as: o.AuthorizationServer = {
    issuer: config.issuer ?? "theremustbeastringhere.dev",
    authorization_endpoint: authorization?.url.toString(),
    token_endpoint: token?.url.toString(),
    userinfo_endpoint: userinfo?.url.toString(),
  };
  applyMultiTenantEntraFix(as, config);
  return {
    ...config,
    checks: config.checks!,
    profile: config.profile!,
    account: config.account!,
    clientId: config.clientId!,
    idToken: config.type === "oidc" ? config.idToken : undefined,
    authorization,
    token,
    userinfo,
    as,
    configSource: "provided",
  };
}