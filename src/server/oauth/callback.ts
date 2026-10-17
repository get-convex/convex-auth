// This maps to packages/core/src/lib/actions/callback/oauth/callback.ts in the @auth/core package (commit 5af1f30a32e64591abc50ae4d2dba4682e525431)

import * as checks from "./checks.js";
import * as o from "oauth4webapi";
import { InternalOptions } from "./types.js";
import { fetchOpt } from "./lib/utils/customFetch.js";
import { Cookie } from "@auth/core/lib/utils/cookie.js";
import { logWithLevel } from "../implementation/utils.js";
import { Account, Profile, TokenSet } from "@auth/core/types.js";
import { isOIDCProvider } from "./lib/utils/providers.js";
import {
  callbackUrl,
  getAuthorizationSignature,
} from "./convexAuth.js";
import { decodeJwt } from "jose";

function formUrlEncode(token: string) {
  return encodeURIComponent(token).replace(/%20/g, "+");
}

/**
 * ConvexAuth: Detect `@auth/core`'s internal `conformInternal` symbol on a
 * provider config without importing it. The symbol is marked `@internal` and
 * is not exposed by the package's `exports` map, so any direct import from
 * `@auth/core/lib/symbols.js` breaks under bundlers that enforce package
 * exports (e.g. Vite during `vitest`).
 *
 * Providers that opt into core conformance logic (currently
 * `microsoft-entra-id`, `azure-ad`, `apple`) set
 * `[conformInternal]: true` using a `Symbol("conform-internal")` instance
 * from `@auth/core`'s internal module. We identify that same symbol on the
 * provider by description and read its value.
 */
function hasConformInternalSymbol(provider: object): boolean {
  for (const sym of Object.getOwnPropertySymbols(provider)) {
    if (
      sym.description === "conform-internal" &&
      (provider as Record<symbol, unknown>)[sym] === true
    ) {
      return true;
    }
  }
  return false;
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

/**
 * Handles the following OAuth steps.
 * https://www.rfc-editor.org/rfc/rfc6749#section-4.1.1
 * https://www.rfc-editor.org/rfc/rfc6749#section-4.1.3
 * https://openid.net/specs/openid-connect-core-1_0.html#UserInfoRequest
 *
 * @note Although requesting userinfo is not required by the OAuth2.0 spec,
 * we fetch it anyway. This is because we always want a user profile.
 */
export async function handleOAuth(
  // ConvexAuth: `params` is a Record<string, string> instead of RequestInternal["query"]
  params: Record<string, string>,
  // ConvexAuth: `cookies` is a Record<string, string | undefined> instead of RequestInternal["cookies"]
  cookies: Record<string, string | undefined>,
  options: InternalOptions<"oauth" | "oidc">,
): Promise<{
  profile: Profile,
  tokens: TokenSet & Pick<Account, "expires_at">,
  cookies: Cookie[],
  signature: string,
}> {
  const { provider } = options;

  // ConvexAuth: The `token` property is not used here
  // ConvexAuth: `as` is `let` because some providers (e.g. Microsoft Entra ID
  // multi-tenant) require re-running OIDC discovery after the token exchange
  // using a claim from the ID token. See the `conformInternal` block below.
  const { userinfo } = provider;
  let { as } = provider;

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
          clientSecretBasic(provider.clientId, provider.clientSecret!),
        );
      };
      break;
    case "client_secret_post":
      clientAuth = o.ClientSecretPost(provider.clientSecret!);
      break;
    case "client_secret_jwt":
      clientAuth = o.ClientSecretJwt(provider.clientSecret!);
      break;
    case "private_key_jwt":
      clientAuth = o.PrivateKeyJwt(provider.token!.clientPrivateKey!, {
        // TODO: review in the next breaking change
        [o.modifyAssertion](_header, payload) {
          payload.aud = [as.issuer, as.token_endpoint!];
        },
      });
      break;
    default:
      throw new Error("unsupported client authentication method");
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
      logWithLevel("DEBUG", "OAuthCallbackError", cause);
      throw new Error("OAuth Provider returned an error", { cause });
    }
    throw err;
  }

  const codeVerifier = await checks.pkce.use(cookies, resCookies, options);

  // ConvexAuth: The logic for the callback URL is different from Auth.js
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

  // ConvexAuth: Ported from @auth/core's `handleOAuth`
  // (packages/core/src/lib/actions/callback/oauth/callback.ts).
  // Some providers (currently Microsoft Entra ID / Azure AD) need the
  // authorization server metadata to be re-processed after the token exchange
  // because the initial discovery document uses a placeholder issuer (e.g.
  // `https://login.microsoftonline.com/{tenantid}/v2.0`) and the real tenant id
  // is only known once we have the ID token. Without this, `validateIssuer`
  // inside `processAuthorizationCodeResponse` rejects the ID token whenever the
  // app is configured as multi-tenant (`/common`, `/organizations`, `/consumers`).
  //
  // `@auth/core` gates this on its internal `conformInternal` symbol, but that
  // symbol is not exported from the package's public entry points (it lives in
  // `@auth/core/lib/symbols.js`, which is not listed in the package's `exports`
  // map). To avoid relying on a deep import that breaks bundlers / Vite, we
  // detect the symbol structurally by description on the provider object.
  if (hasConformInternalSymbol(provider)) {
    switch (provider.id) {
      case "microsoft-entra-id":
      case "azure-ad": {
        /**
         * These providers return errors in the response body and
         * need the authorization server metadata to be re-processed
         * based on the `id_token`'s `tid` claim.
         * @see: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#error-response-1
         */
        const responseJson = await codeGrantResponse.clone().json();
        if (responseJson.error) {
          const cause = {
            providerId: provider.id,
            ...responseJson,
          };
          logWithLevel("DEBUG", "OAuthCallbackError", cause);
          throw new Error(
            `OAuth Provider returned an error: ${responseJson.error}`,
            { cause },
          );
        }
        const { tid } = decodeJwt(responseJson.id_token);
        if (typeof tid === "string") {
          // Match any URL path segment so we cover both authority names like
          // `common`/`organizations`/`consumers` and hyphenated tenant GUIDs.
          // Rewrite via the segment-anchored regex (not a substring replace)
          // so we can't accidentally clobber an unrelated part of the URL.
          const tenantSegmentRe = /microsoftonline\.com\/[^/]+\/v2\.0/;
          const issuer = new URL(
            as.issuer.replace(
              tenantSegmentRe,
              `microsoftonline.com/${tid}/v2.0`,
            ),
          );
          // ConvexAuth: Rewrite the `{tenantid}` placeholder Microsoft returns
          // in the discovery document's `issuer` field using the real `tid`
          // from the ID token. The provider's own `customFetch` hook (in
          // `@auth/core@0.37.x`) derives the replacement from `config.issuer`
          // captured at construction, so it can't see the per-tenant authority
          // during this re-discovery. The upstream fix at
          // https://github.com/nextauthjs/next-auth/pull/13440 derives the
          // tenant from the request URL instead; once an `@auth/core` release
          // including it is pinned, this wrapper can defer to
          // `provider[customFetch]`.
          const discoveryResponse = await o.discoveryRequest(issuer, {
            [o.customFetch]: async (
              ...args: Parameters<typeof fetch>
            ) => {
              const response = await fetch(...args);
              const first = args[0];
              const requestUrl =
                typeof first === "string"
                  ? first
                  : first instanceof URL
                    ? first.toString()
                    : first.url;
              if (
                !requestUrl.endsWith(".well-known/openid-configuration")
              ) {
                return response;
              }
              const json = await response.clone().json();
              if (
                typeof json?.issuer === "string" &&
                json.issuer.includes("{tenantid}")
              ) {
                return Response.json({
                  ...json,
                  issuer: json.issuer.replace("{tenantid}", tid),
                });
              }
              return response;
            },
          });
          as = await o.processDiscoveryResponse(issuer, discoveryResponse);
        }
        break;
      }
      default:
        break;
    }
  }

  // ConvexAuth: We use the value of the nonce later, aside from feeding it into the
  // `processAuthorizationCodeResponse` function.
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

    // Apple sends some of the user information in a `user` parameter as a stringified JSON.
    // It also only does so the first time the user consents to share their information.
    if (provider.id === "apple") {
      try {
        profile.user = JSON.parse(params?.user)
        // ConvexAuth: disabled lint for empty block
        // eslint-disable-next-line no-empty
      } catch {}
    } 
    
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
