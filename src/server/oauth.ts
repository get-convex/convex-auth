// Some code adapted from Auth.js. Original license:
//
// ISC License
//
// Copyright (c) 2022-2024, Balázs Orbán
//
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

import { Cookie } from "@auth/core/lib/utils/cookie";
import {
  OAuth2Config,
  OAuthConfig,
  OAuthEndpointType,
  OIDCConfig,
  TokenEndpointHandler,
  UserinfoEndpointHandler,
} from "@auth/core/providers";
import { Account, TokenSet } from "@auth/core/types";
import * as o from "oauth4webapi";
import * as checks from "./checks.js";
import { normalizeEndpoint } from "./provider_utils.js";
import { requireEnv } from "./utils.js";
import { LOG_LEVELS, logWithLevel } from "./implementation/utils.js";

export type InternalProvider = (
  | OAuthConfigInternal<any>
  | OIDCConfigInternal<any>
) & {
  signinUrl: string;
  // TODO(convex auth): DO we need this?
  // callbackUrl: string;
};

export async function getAuthorizationURL(provider: InternalProvider) {
  const {
    authorization,
    server,
    checks: providerChecks,
  } = await getOAuthConfig(provider);
  const url = authorization!.url;
  const authParams = url.searchParams;

  const redirect_uri: string = callbackUrl(provider.id);
  // let data: object | undefined;
  // TODO(convex auth): Support redirect proxy
  // if (!options.isOnRedirectProxy && provider.redirectProxyUrl) {
  //   redirect_uri = provider.redirectProxyUrl;
  //   data = { origin: provider.callbackUrl };
  //   logger.debug("using redirect proxy", { redirect_uri, data });
  // }

  if (provider.clientId === undefined) {
    throw new Error(`Missing \`clientId\`, set \`${clientId(provider.id)}\``);
  }
  if (provider.clientSecret === undefined) {
    throw new Error(
      `Missing \`clientSecret\`, set \`${clientSecret(provider.id)}\``,
    );
  }

  for (const [key, value] of Object.entries({
    response_type: "code",
    // clientId can technically be undefined, should we check this in assert.ts or rely on the Authorization Server to do it?
    client_id: provider.clientId,
    redirect_uri,
    // (convex-auth) Ugh here we use
    // the original params config from the provider
    // @ts-expect-error TODO:
    ...provider.authorization?.params,
  })) {
    authParams.set(key, value as string);
  }

  const cookies: Cookie[] = [];

  if (provider.checks?.includes("state")) {
    const { state, cookie } = checks.state.create(provider);
    authParams.set("state", state);
    cookies.push(cookie);
  }

  let codeVerifier: string | undefined;
  if (providerChecks?.includes("pkce")) {
    if (
      server === null ||
      server.code_challenge_methods_supported?.includes("S256")
    ) {
      const result = await checks.pkce.create(provider);
      authParams.set("code_challenge", result.codeChallenge);
      authParams.set("code_challenge_method", "S256");
      cookies.push(result.cookie);
      codeVerifier = result.codeVerifier;
    }
  }

  // @ts-expect-error TS is confused by the combined types
  if (providerChecks?.includes("nonce")) {
    const { nonce, cookie } = await checks.nonce.create(provider);
    authParams.set("nonce", nonce);
    cookies.push(cookie);
  }

  if (!url.searchParams.has("scope")) {
    authParams.set("scope", "openid profile email");
  }

  // logger.debug("authorization url is ready", { url, cookies, provider });
  return {
    redirect: url.toString(),
    cookies,
    signature: getAuthorizationSignature({
      codeVerifier,
      state: authParams.get("state") ?? undefined,
      nonce: authParams.get("nonce") ?? undefined,
    }),
  };
}

function formUrlEncode(token: string) {
  return encodeURIComponent(token).replace(/%20/g, "+")
}

/**
 * Formats client_id and client_secret as an HTTP Basic Authentication header as per the OAuth 2.0
 * specified in RFC6749.
 */
function clientSecretBasic(clientId: string, clientSecret: string) {
  const username = formUrlEncode(clientId)
  const password = formUrlEncode(clientSecret)
  const credentials = btoa(`${username}:${password}`)
  return `Basic ${credentials}`
}

export async function handleOAuthCallback(
  provider: InternalProvider,
  request: Request,
  cookies: Record<string, string | undefined>,
) {
  const {
    userinfo,
    server: realServer,
    fakeServer,
    checks: providerChecks,
  } = await getOAuthConfig(provider);
  const server = realServer ?? fakeServer;

  const client: o.Client = {
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    ...provider.client,
  };

  let clientAuth: o.ClientAuth;

  // ConvexAuth: this switch block comes from:
  // https://github.com/nextauthjs/next-auth/blob/4b01b466b1d65d36945c07f1ee1d4944b218113d/packages/core/src/lib/actions/callback/oauth/callback.ts#L95
  // 
  // Our version doesn't support the "private_key_jwt" token_endpoint_auth_method though.
  switch (client.token_endpoint_auth_method) {
    // TODO: in the next breaking major version have undefined be `client_secret_post`
    case undefined:
    case "client_secret_basic":
      // TODO: in the next breaking major version use o.ClientSecretBasic() here
      clientAuth = (_as, _client, _body, headers) => {
        headers.set(
          "authorization",
          clientSecretBasic(provider.clientId, provider.clientSecret!)
        );
      }
      break;
    case "client_secret_post":
      clientAuth = o.ClientSecretPost(provider.clientSecret!);
      break;
    case "client_secret_jwt":
      clientAuth = o.ClientSecretJwt(provider.clientSecret!);
      break;
    case "none":
      clientAuth = o.None();
      break;
    default:
      throw new Error("unsupported client authentication method:" + client.token_endpoint_auth_method);
  }

  const updatedCookies: Cookie[] = [];

  let state: string | undefined;
  if (providerChecks?.includes("state")) {
    const result = checks.state.use(provider, cookies);
    updatedCookies.push(result.updatedCookie);
    state = result.state;
  }

  const params = new URL(request.url).searchParams;

  // Handle OAuth providers that use formData (such as Apple)
  if (
    request.headers.get("Content-Type") === "application/x-www-form-urlencoded"
  ) {
    const formData = await request.formData();
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") {
        params.append(key, value);
      }
    }
  }

  const codeGrantParams = o.validateAuthResponse(
    server,
    client,
    params,
    providerChecks?.includes("state") ? state : o.skipStateCheck,
  );

  let codeVerifier;
  if (providerChecks?.includes("pkce")) {
    const result = checks.pkce.use(provider, cookies);
    updatedCookies.push(result.updatedCookie);
    codeVerifier = result.codeVerifier;
  }

  const redirect_uri = callbackUrl(provider.id);
  // TODO(convex auth): Support redirect proxy
  // if (!options.isOnRedirectProxy && provider.redirectProxyUrl) {
  //   redirect_uri = provider.redirectProxyUrl;
  // }
  let codeGrantResponse = await o.authorizationCodeGrantRequest(
    server,
    client,
    clientAuth,
    codeGrantParams,
    redirect_uri,
    codeVerifier ?? "auth", // TODO: review fallback code verifier,
    {
      // https://github.com/nextauthjs/next-auth/pull/10765
      [o.customFetch]: (...args) => {
        if (
          !providerChecks.includes("pkce") &&
          args[1]?.body instanceof URLSearchParams
        ) {
          args[1].body.delete("code_verifier");
        }
        return fetch(...args);
      },
    },
  );

  if (provider.token?.conform) {
    codeGrantResponse =
      (await provider.token.conform(codeGrantResponse.clone())) ??
      codeGrantResponse;
  }

  let profile: any = {};
  let tokens: TokenSet & Pick<Account, "expires_at">;

  let nonce;
  if (provider.type === "oidc") {
    // @ts-expect-error TS is confused by the combined types
    if (providerChecks?.includes("nonce")) {
      const result = checks.nonce.use(provider, cookies);
      updatedCookies.push(result.updatedCookie);
      nonce = result.nonce;
    }
    const result = await o.processAuthorizationCodeResponse(
      server,
      client,
      codeGrantResponse,
      {
        expectedNonce: nonce ?? o.expectNoNonce,
        requireIdToken: true,
      }
    );

    profile = o.getValidatedIdTokenClaims(result);
    // Apple sends some of the user information in a `user` parameter as a stringified JSON.
    // It also only does so the first time the user consents to share their information.
    // ConvexAuth: code adapted from https://github.com/nextauthjs/next-auth/blob/1c9bcdd0c4538a852f8d2b2b7c60eb962e3a50eb/packages/core/src/lib/actions/callback/oauth/callback.ts#L231
    if (provider.id === "apple") {
      try {
        const userData = params.get("user");
        if (userData) {
          profile.user = JSON.parse(userData);
        }
      } catch {}
    }
    
    tokens = result;
  } else {
    tokens = await o.processAuthorizationCodeResponse(
      server,
      client,
      codeGrantResponse,
    );

    if (userinfo?.request) {
      const _profile = await userinfo.request({ tokens, provider });
      if (_profile instanceof Object) profile = _profile;
    } else if (userinfo?.url) {
      const userinfoResponse = await o.userInfoRequest(
        server,
        client,
        (tokens as any).access_token,
      );
      profile = await userinfoResponse.json();
    } else {
      logWithLevel(
        LOG_LEVELS.WARN,
        `No userinfo endpoint configured for ${provider.id}`,
      );
    }
  }

  if (tokens.expires_in) {
    tokens.expires_at =
      Math.floor(Date.now() / 1000) + Number(tokens.expires_in);
  }
  return {
    profile: profile as Object,
    cookies: updatedCookies,
    tokens,
    signature: getAuthorizationSignature({ codeVerifier, state, nonce }),
  };
}

// TODO(convex auth): We need to support custom callback URLs
function callbackUrl(providerId: string) {
  return requireEnv("CONVEX_SITE_URL") + "/api/auth/callback/" + providerId;
}

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

type OIDCConfigInternal<Profile> = OAuthConfigInternal<Profile> & {
  checks: OIDCConfig<Profile>["checks"];
};

type OAuthConfigInternal<Profile> = Omit<
  OAuthConfig<Profile>,
  OAuthEndpointType | "redirectProxyUrl"
> & {
  authorization?: { url: URL };
  token?: {
    url: URL;
    request?: TokenEndpointHandler["request"];
    /** @internal */
    conform?: TokenEndpointHandler["conform"];
  };
  userinfo?: { url: URL; request?: UserinfoEndpointHandler["request"] };
  /**
   * Reconstructed from {@link OAuth2Config.redirectProxyUrl},
   * adding the callback action and provider id onto the URL.
   *
   * If defined, it is favoured over {@link OAuthConfigInternal.callbackUrl} in the authorization request.
   *
   * When {@link InternalOptions.isOnRedirectProxy} is set, the actual value is saved in the decoded `state.origin` parameter.
   *
   * @example `"https://auth.example.com/api/auth/callback/:provider"`
   *
   */
  redirectProxyUrl?: OAuth2Config<Profile>["redirectProxyUrl"];
} & Pick<
    Required<OAuthConfig<Profile>>,
    "clientId" | "checks" | "profile" | "account"
  >;

function clientId(providerId: string) {
  return `AUTH_${envProviderId(providerId)}_ID`;
}

function clientSecret(providerId: string) {
  return `AUTH_${envProviderId(providerId)}_SECRET`;
}

function envProviderId(provider: string) {
  return provider.toUpperCase().replace(/-/g, "_");
}

async function getOAuthConfig(provider: InternalProvider) {
  if (!provider.authorization || !provider.token || !provider.userinfo) {
    if (!provider.issuer) {
      throw new Error(
        `Provider \`${provider.id}\` is missing an \`issuer\` URL configuration. Consult the provider docs.`,
      );
    }
    const discovery = `${provider.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const response = await fetch(discovery);
    const config = await response.json();
    return {
      ...provider,
      checks:
        provider.type === "oidc" &&
        provider.checks?.includes("pkce") &&
        !config.code_challenge_methods_supported?.includes("S256")
          ? ["nonce"]
          : provider.checks,
      server: config as {
        issuer: string;
        authorization_endpoint: string;
        token_endpoint: string;
        userinfo_endpoint?: string;
        code_challenge_methods_supported: string[];
      },
      fakeServer: null,
      authorization: normalizeEndpoint({
        ...provider.authorization,
        url: new URL(config.authorization_endpoint),
      }),
      token: normalizeEndpoint({
        ...provider.token,
        url: new URL(config.token_endpoint),
      }),
      userinfo: config.userinfo_endpoint
        ? normalizeEndpoint({
            ...provider.userinfo,
            url: new URL(config.userinfo_endpoint),
          })
        : provider.userinfo,
    };
  } else {
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
      fakeServer: {
        issuer: provider.issuer ?? "theremustbeastringhere.dev",
        authorization_endpoint: authorization?.url.toString(),
        token_endpoint: token?.url.toString(),
        userinfo_endpoint: userinfo?.url.toString(),
      },
      server: null,
    };
  }
}
