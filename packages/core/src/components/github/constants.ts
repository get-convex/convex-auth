/**
 * Everything about GitHub that never varies between apps. That is the
 * endpoints, the scopes, and the shapes its userinfo endpoints return.
 *
 * This component serves GitHub only, so these are constants rather than
 * configuration. The response types live here because the endpoint map is
 * keyed by them.
 *
 * @module
 */
/** Where the browser is sent to sign in. */
export const AUTHORIZATION_ENDPOINT =
  "https://github.com/login/oauth/authorize";

/** Where the authorization code is exchanged for tokens. */
export const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";

/** A GitHub `/user/emails` entry, the fields the mapping reads. */
type GithubEmail = { email: string; primary: boolean; verified: boolean };

/** The GitHub `/user` fields the mapping reads. */
type GithubUser = {
  id: number | string;
  login: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string;
};

/**
 * The responses the component's userinfo endpoints produce, keyed the way
 * {@link USER_INFO_ENDPOINTS} names them. This is what GitHub is trusted to
 * return; the responses are not validated against it at runtime.
 */
export type GithubUserInfo = { user: GithubUser; emails: GithubEmail[] };

/**
 * What the callback fetches with the access token, keyed by the name the
 * profile mapping reads each response under. GitHub is plain OAuth and
 * returns no id_token, so this is where identity comes from. The emails
 * endpoint is separate because the public profile's email is often absent and
 * carries no verification status.
 */
export const USER_INFO_ENDPOINTS: Record<keyof GithubUserInfo, string> = {
  user: "https://api.github.com/user",
  emails: "https://api.github.com/user/emails",
};

/** What the sign-in asks for. */
export const SCOPES = ["read:user", "user:email"];

/** The name this provider's accounts are namespaced under in the core. */
export const PROVIDER_NAME = "github";
