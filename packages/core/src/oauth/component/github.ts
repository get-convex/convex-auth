import { Infer, v } from "convex/values";
import type { UserCallbacks } from "../../lib/types.js";
import type { AuthCore } from "../../components/core/setup.js";
import {
  setupOauth,
  type OauthCatalog,
  type OauthProfile,
  type OauthProviderOptions,
} from "./setup.js";

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
export const normalizeGithubProfile: OauthProfile<
  GithubProfile,
  GithubUserInfo
> = (_claims, userInfoResponses) => {
  const user = userInfoResponses?.user;
  if (user === undefined) {
    throw new Error("GitHub userinfo response is missing the `user` entry");
  }
  // The response is untrusted JSON, and String() would turn a missing id
  // into the literal string "undefined", collapsing every affected user
  // into one account.
  if (typeof user.id !== "number" && typeof user.id !== "string") {
    throw new Error("GitHub userinfo `user` entry is missing an id");
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
const githubCatalog: OauthCatalog<GithubProfile, GithubUserInfo> = {
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
 * Built-in GitHub OAuth provider. Wire it up with its own oauth component
 * instance:
 *
 * ```ts
 * export const { startSignInGithub, completeSignInGithub } = setupGithub(core, {
 *   component: components.oauthGithub,
 *   allowedRedirectOrigins: ["https://app.example.com", "http://localhost:5173"],
 * }).attachUserCallbacks({ createUser: internal.users.createUserGithub });
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
export function setupGithub<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: OauthProviderOptions,
) {
  return {
    /**
     * Supply the app's user callbacks (see {@link UserCallbacks} for how their
     * args must be declared) and get this provider's functions to export.
     */
    attachUserCallbacks(
      callbacks: UserCallbacks<"github", GithubProfile, UsersTable>,
    ) {
      const { startSignIn, completeSignIn } = setupOauth(
        core,
        "github",
        githubCatalog,
        callbacks,
        options,
      );
      return {
        startSignInGithub: startSignIn,
        completeSignInGithub: completeSignIn,
      };
    },
  };
}
