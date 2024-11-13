// This maps to packages/core/src/providers/oauth.ts in the @auth/core package (commit 5af1f30a32e64591abc50ae4d2dba4682e525431)

// ConvexAuth: only a few types were brought in.

import {
  OAuth2Config,
  OAuthConfig,
  OAuthEndpointType,
  OIDCConfig,
  TokenEndpointHandler,
  UserinfoEndpointHandler,
} from "@auth/core/providers/index.js";
import { PrivateKey } from "oauth4webapi";

/**
 * We parsed `authorization`, `token` and `userinfo`
 * to always contain a valid `URL`, with the params
 * @internal
 */
export type OAuthConfigInternal<Profile> = Omit<
  OAuthConfig<Profile>,
  OAuthEndpointType | "redirectProxyUrl"
> & {
  authorization?: { url: URL };
  token?: {
    url: URL;
    request?: TokenEndpointHandler["request"];
    clientPrivateKey?: CryptoKey | PrivateKey;
    /**
     * @internal
     * @deprecated
     */
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

export type OIDCConfigInternal<Profile> = OAuthConfigInternal<Profile> & {
  checks: OIDCConfig<Profile>["checks"];
  idToken: OIDCConfig<Profile>["idToken"];
};
