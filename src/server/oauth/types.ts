// This maps to packages/core/src/types.ts in the @auth/core package (commit 5af1f30a32e64591abc50ae4d2dba4682e525431).

import * as AuthCoreJwt from "@auth/core/jwt";
import { CookieOption, CookiesOptions } from "@auth/core/types.js";
import { OAuthConfigInternal, OIDCConfigInternal } from "./providers/oauth.js";
import { ProviderType } from "@auth/core/providers/index.js";
import * as o from "oauth4webapi";

export type ConvexAuthProviderType = "oauth" | "oidc";

export type ConfigSource = "discovered" | "provided";

// ConvexAuth: Auth.js has a more complex type for this, ours is stripped down.
export type InternalProvider<T = ProviderType> = (T extends "oauth"
  ? OAuthConfigInternal<any>
  : T extends "oidc"
    ? OIDCConfigInternal<any>
    : never)  & {as: o.AuthorizationServer, configSource: ConfigSource}


// ConvexAuth: `secret` is internal to @auth/core, so we copy its type here
export type JWTOptions = AuthCoreJwt.JWTOptions & { secret: string | string[] };

/** @internal */
export interface InternalOptions<TProviderType extends ConvexAuthProviderType> {
  // providers: InternalProvider<TProviderType>[];
  // url: URL;
  // ConvexAuth: omit this option for now
  // action: AuthAction;
  provider: InternalProvider<TProviderType>;
  // csrfToken?: string;
  /**
   * `true` if the [Double-submit CSRF check](https://owasp.org/www-chapter-london/assets/slides/David_Johansson-Double_Defeat_of_Double-Submit_Cookie.pdf) was succesful
   * or [`skipCSRFCheck`](https://authjs.dev/reference/core#skipcsrfcheck) was enabled.
   */
  // csrfTokenVerified?: boolean;
  // secret: string | string[];
  // ConvexAuth: omit the following options for now
  //   theme: Theme;
  //   debug: boolean;
  //   logger: LoggerInstance;
  //   session: NonNullable<Required<AuthConfig["session"]>>;
  //   pages: Partial<PagesOptions>;
  // jwt: JWTOptions;
  //   events: NonNullable<AuthConfig["events"]>;
  //   adapter: Required<Adapter> | undefined;
  //   callbacks: NonNullable<Required<AuthConfig["callbacks"]>>;
  cookies: Record<keyof CookiesOptions, CookieOption>;
  // callbackUrl: string;
  /**
   * If true, the OAuth callback is being proxied by the server to the original URL.
   * See also {@link OAuthConfigInternal.redirectProxyUrl}.
   */
  // isOnRedirectProxy: boolean;
  //   experimental: NonNullable<AuthConfig["experimental"]>;
  // basePath: string;
}

// ConvexAuth: There are several more types in the original file which we don't need,
// and are omitted here.
