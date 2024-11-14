import { CookieOption, CookiesOptions } from "@auth/core/types.js";
import { requireEnv } from "../utils.js";
import { InternalProvider } from "./types.js";
import { SHARED_COOKIE_OPTIONS } from "../cookies.js";
import { fetchOpt } from "./lib/utils/customFetch.js";
import * as o from "oauth4webapi";
import { normalizeEndpoint } from "../provider_utils.js";
import { isLocalHost } from "../utils.js";

// ConvexAuth: The logic for the callback URL is different from Auth.js
export function callbackUrl(providerId: string) {
  return requireEnv("CONVEX_SITE_URL") + "/api/auth/callback/" + providerId;
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
      name: oauthStateCookieName("nonce", providerId),
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

export type ConfigSource = "discovered" | "provided";

export async function getConfig(provider: InternalProvider<"oauth" | "oidc">): Promise<InternalProvider<"oauth" | "oidc"> & {as: o.AuthorizationServer, configSource: ConfigSource}> {
  // Only do service discovery if the provider does not have the required configuration
  if (!provider.authorization || !provider.token || !provider.userinfo) {
    // Taken from https://github.com/nextauthjs/next-auth/blob/a7491dcb9355ff2d01fb8e9236636605e2090145/packages/core/src/lib/actions/callback/oauth/callback.ts#L63
    if (!provider.issuer) {
      throw new Error(
        `Provider \`${provider.id}\` is missing an \`issuer\` URL configuration. Consult the provider docs.`,
      );
    }

    const issuer = new URL(provider.issuer);
    // TODO: move away from allowing insecure HTTP requests
    const discoveryResponse = await o.discoveryRequest(issuer, {
      ...fetchOpt(provider),
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

    if (!discoveredAs.userinfo_endpoint)
      throw new TypeError(
        "TODO: Authorization server did not provide a userinfo endpoint.",
      );

    const as: o.AuthorizationServer = discoveredAs;
    return {
      ...provider,
      // ConvexAuth: Apparently it's important for us to normalize the endpoint after
      // service discovery (https://github.com/get-convex/convex-auth/commit/35bf716bfb0d29dbce1cbca318973b0732f75015)
      authorization: normalizeEndpoint({
        ...provider.authorization,
        url: as.authorization_endpoint,
      }),
      token: normalizeEndpoint({
        ...provider.token,
        url: as.token_endpoint,
      }),
      userinfo: as.userinfo_endpoint
        ? normalizeEndpoint({
            ...provider.userinfo,
            url: as.userinfo_endpoint,
          })
        : provider.userinfo,
      as,
      configSource: "discovered"
    };
  }

  const authorization = normalizeEndpoint(provider.authorization);
  const token = normalizeEndpoint(provider.token);
  const userinfo = provider.userinfo
    ? normalizeEndpoint(provider.userinfo)
    : undefined;
  return {
    ...provider,
    authorization,
    token,
    userinfo,
    as: {
      issuer: provider.issuer ?? "theremustbeastringhere.dev",
      authorization_endpoint: authorization?.url.toString(),
      token_endpoint: token?.url.toString(),
      userinfo_endpoint: userinfo?.url.toString(),
    },
    configSource: "provided",
  };
}
