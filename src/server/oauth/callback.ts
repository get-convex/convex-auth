// This maps to packages/core/src/lib/actions/callback/oauth/callback.ts in the @auth/core package.

import * as o from "oauth4webapi";
import { InternalOptions } from "./types";
import { Cookie } from "@auth/core/lib/utils/cookie.js";
import * as checks from "./checks";
import { isOIDCProvider } from "./lib/utils/providers.js";
import { Account, Profile, TokenSet } from "@auth/core/types.js";
import { requireEnv } from "../utils.js";
import { fetchOpt } from "./lib/utils/customFetch.js";

function formUrlEncode(token: string) {
  return encodeURIComponent(token).replace(/%20/g, "+");
}

/**
 * Formats client_id and client_secret as an HTTP Basic Authentication header as per the OAuth 2.0
 * specified in RFC6749.
 */
function clientSecretBasic(clientId: string, clientSecret: string) {
  const username = formUrlEncode(clientId);
  const password = formUrlEncode(clientSecret);
  const credentials = btoa(`${username}:${password}`);
  return `Basic ${credentials}`;
}

export async function handleOAuthCallback(
  params: any,
  cookies: any,
  options: InternalOptions<"oauth" | "oidc">,
): Promise<any> {
  const { provider } = options;
  const { userinfo } = provider;

  // Get authorization server
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

  // Authorization Server
  // ConvexAuth -- we're omitting a Auth.js specific fallback
  const as = discoveredAs;

  const client: o.Client = {
    client_id: provider.clientId,
    ...provider.client,
  };

  let clientAuth: o.ClientAuth;

  switch (client.token_endpoint_auth_method) {
    // TODO: in the next breaking major version have undefined be `client_secret_post`
    case undefined:
    case "client_secret_basic":
      // TODO: in the next breaking major version use o.ClientSecretBasic() here
      clientAuth = (_as, _client, _body, headers) => {
        headers.set(
          "authorization",
          clientSecretBasic(provider.clientId, provider.clientSecret),
        );
      };
      break;
    case "client_secret_post":
      clientAuth = o.ClientSecretPost(provider.clientSecret);
      break;
    default:
      // ConvexAuth: Auth.js supports a few more methods, but they're not used in
      // our most common providers, so skip supporting them for now.
      throw new Error(
        `[ConvexAuth] Unsupported token endpoint auth method: ${client.token_endpoint_auth_method}`,
      );
  }

  const resCookies: Cookie[] = [];

  const state = await checks.state.use(cookies, resCookies, options);

  let codeGrantParams: URLSearchParams;
  try {
    codeGrantParams = o.validateAuthResponse(
      as,
      client,
      new URLSearchParams(params),
      provider.checks.includes("state") ? state : o.skipStateCheck,
    );
  } catch (err) {
    if (err instanceof o.AuthorizationResponseError) {
      const cause = {
        providerId: provider.id,
        ...Object.fromEntries(err.cause.entries()),
      };
      throw new Error("OAuth Provider returned an error", { cause });
    }
    throw err;
  }

  const codeVerifier = await checks.pkce.use(cookies, resCookies, options);
  const redirect_uri = callbackUrl(provider.id);
  // TODO(ConvexAuth): Support redirect proxy URLs
  // if (!options.isOnRedirectProxy && provider.redirectProxyUrl) {
  //   redirect_uri = provider.redirectProxyUrl;
  // }

  let codeGrantResponse = await o.authorizationCodeGrantRequest(
    as,
    client,
    clientAuth,
    codeGrantParams,
    redirect_uri,
    codeVerifier ?? "decoy",
    {
      // TODO: move away from allowing insecure HTTP requests
      [o.allowInsecureRequests]: true,
      [o.customFetch]: (...args) => {
        if (!provider.checks.includes("pkce")) {
          args[1].body.delete("code_verifier");
        }
        return fetchOpt(provider)[o.customFetch](...args);
      },
    },
  );

  if (provider.token?.conform) {
    codeGrantResponse =
      (await provider.token.conform(codeGrantResponse.clone())) ??
      codeGrantResponse;
  }

  let profile: Profile = {};

  const nonce = await checks.nonce.use(cookies, resCookies, options);
  const isOidc = isOIDCProvider(provider);
  const processedCodeResponse = await o.processAuthorizationCodeResponse(
    as,
    client,
    codeGrantResponse,
    {
      expectedNonce: nonce,
      requireIdToken: isOidc,
    },
  );

  const tokens: TokenSet & Pick<Account, "expires_at"> = processedCodeResponse;

  if (isOidc) {
    // ConvexAuth: the next few lines are changed slightly to make TypeScript happy
    const idTokenClaimsOrUndefined = o.getValidatedIdTokenClaims(
      processedCodeResponse,
    );
    if (idTokenClaimsOrUndefined === undefined) {
      throw new Error("ID Token claims are missing");
    }
    const idTokenClaims = idTokenClaimsOrUndefined;
    profile = idTokenClaims;

    if (provider.idToken === false) {
      const userinfoResponse = await o.userInfoRequest(
        as,
        client,
        processedCodeResponse.access_token,
        {
          ...fetchOpt(provider),
          // TODO: move away from allowing insecure HTTP requests
          [o.allowInsecureRequests]: true,
        },
      );

      profile = await o.processUserInfoResponse(
        as,
        client,
        idTokenClaims.sub,
        userinfoResponse,
      );
    }
  } else {
    if (userinfo?.request) {
      const _profile = await userinfo.request({ tokens, provider });
      if (_profile instanceof Object) profile = _profile;
    } else if (userinfo?.url) {
      const userinfoResponse = await o.userInfoRequest(
        as,
        client,
        processedCodeResponse.access_token,
        fetchOpt(provider),
      );
      profile = await userinfoResponse.json();
    } else {
      throw new TypeError("No userinfo endpoint configured");
    }
  }

  if (tokens.expires_in) {
    tokens.expires_at =
      Math.floor(Date.now() / 1000) + Number(tokens.expires_in);
  }
  // ConvexAuth: The Auth.js code would handle user + account creation here, but for
  // ConvexAuth we want to handle that in a Convex function. Instead, we return the
  // information needed for the mutation.

  return {
    profile,
    tokens,
    cookies: resCookies,
    signature: getAuthorizationSignature({ codeVerifier, state, nonce }),
  };
}

// ConvexAuth: The logic for the callback URL is different from Auth.js
function callbackUrl(providerId: string) {
  return requireEnv("CONVEX_SITE_URL") + "/api/auth/callback/" + providerId;
}

// ConvexAuth: This is a ConvexAuth specific function that produces a string that the
// Convex functions will validate
function getAuthorizationSignature({
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
