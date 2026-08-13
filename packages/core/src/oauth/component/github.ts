import { Infer, v } from "convex/values";
import { defineProvider } from "../../lib/types";
import {
  setupOauth,
  type OauthCatalog,
  type OauthProfile,
  type OauthProviderOptions,
} from "./setup";

/**
 * The account profile the GitHub provider produces. GitHub is plain OAuth
 * (no id_token), so identity comes from its userinfo endpoints. This is the
 * exact shape the mapping emits, so the app can validate against it
 * precisely.
 */
export const vGithubProfile = v.object({
  /** GitHub's numeric user id as a string, the stable provider account id. */
  id: v.string(),
  login: v.string(),
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  /**
   * True when the email came from a verified `/user/emails` entry. False
   * means it fell back to the `/user` public profile email, whose
   * verification status is unknown, so don't trust it for account linking.
   */
  emailVerified: v.boolean(),
  avatarUrl: v.optional(v.string()),
});

export type GithubProfile = Infer<typeof vGithubProfile>;

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
 * The userinfo responses the catalog's endpoints produce, keyed like its
 * `userInfoEndpoints` (see {@link OauthProfile}).
 */
type GithubUserInfo = { user: GithubUser; emails: GithubEmail[] };

/** Map GitHub's userinfo responses to {@link GithubProfile}. */
export const normalizeGithubProfile: OauthProfile<GithubUserInfo> = (
  _claims,
  userInfoResponses,
) => {
  const user = userInfoResponses?.user;
  if (user === undefined) {
    throw new Error("GitHub userinfo response is missing the `user` entry");
  }
  const emails = userInfoResponses?.emails ?? [];
  const verifiedEmail =
    emails.find((entry) => entry.primary && entry.verified) ??
    emails.find((entry) => entry.verified);
  return {
    id: String(user.id),
    login: user.login,
    name: user.name ?? user.login,
    email: verifiedEmail?.email ?? user.email ?? undefined,
    emailVerified: verifiedEmail !== undefined,
    avatarUrl: user.avatar_url,
  };
};

/** GitHub's endpoints, scopes, and profile mapping. */
const githubCatalog: OauthCatalog<GithubUserInfo> = {
  authorizationEndpoint: "https://github.com/login/oauth/authorize",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  scopes: ["read:user", "user:email"],
  pkce: true,
  userInfoEndpoints: {
    user: "https://api.github.com/user",
    emails: "https://api.github.com/user/emails",
  },
  profile: normalizeGithubProfile,
};

/**
 * Built-in GitHub OAuth provider. Register it with its own oauth component
 * instance:
 *
 * ```ts
 * provider(OauthGithub, {
 *   component: components.oauthGithub,
 *   allowedRedirectOrigins: ["https://app.example.com", "http://localhost:5173"],
 * })
 * ```
 *
 * Setup:
 *
 * 1. Install the component in convex.config.ts under
 *    `httpPrefix: "/oauth/github"`, binding GitHub's `CLIENT_ID` and
 *    `CLIENT_SECRET`.
 * 2. Register `<site-url>/oauth/github/callback` as the redirect URI with
 *    GitHub.
 *
 * The `httpPrefix` alone determines the callback URL.
 */
export const OauthGithub = defineProvider({
  name: "github",
  setup: (helpers, options: OauthProviderOptions) => {
    const { startSignIn, completeSignIn } = setupOauth(
      "github",
      githubCatalog,
      helpers,
      options,
    );
    return {
      startSignInGithub: startSignIn,
      completeSignInGithub: completeSignIn,
    };
  },
});
