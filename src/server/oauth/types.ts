// This maps to packages/core/src/types.ts in the @auth/core package (commit 5af1f30a32e64591abc50ae4d2dba4682e525431).

import { JWTOptions } from "@auth/core/jwt.js";
import { CookieOption, CookiesOptions } from "@auth/core/types.js";

export type ConvexAuthProviderType = "oauth" | "oidc";

// ConvexAuth: Auth.js has a more complex type for this, but it's internal.
// For now, just use `any` and accept the type unsafety.
export type InternalProvider<T extends ConvexAuthProviderType> = any;

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
  // ConvexAuth: `secret` is internal to @auth/core, so we copy its type here
  jwt: JWTOptions & { secret: string | string[] };
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
