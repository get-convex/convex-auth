import { authUrlFromEnv } from "../server/url";

/** @internal */
export function defaultOAuthRedirectUri(providerId: string, redirectUri?: string) {
  return redirectUri ?? `${authUrlFromEnv()}/callback/${providerId}`;
}
