import { Infer, v } from "convex/values";
import { defineProvider } from "../../lib/types";
import {
  setupOauth,
  type OauthCatalog,
  type OauthProfile,
  type OauthProviderOptions,
} from "./setup";

/**
 * The account profile the GitHub provider produces. GitHub is plain OAuth (no
 * id_token), so identity comes from its userinfo endpoints; this is the exact
 * shape the mapping emits, so the app can validate against it precisely.
 */
export const vGithubProfile = v.object({
  /** GitHub's numeric user id, stringified — the stable provider account id. */
  id: v.string(),
  login: v.string(),
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  /**
   * True when the selected email came from a verified `/user/emails` entry.
   * False means it fell back to the `/user` public profile email, whose
   * verification status is unknown — either way, don't trust the email for
   * account linking.
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
 * Map GitHub's userinfo responses to {@link GithubProfile}. `user` comes from
 * `/user` and `emails` from `/user/emails` (the endpoints the catalog fetches).
 * Email prefers the primary verified address, then any verified one, then
 * whatever `/user` returned — `emailVerified` reports whether the chosen
 * address came from a verified entry; `name` falls back to the login handle.
 */
export const normalizeGithubProfile: OauthProfile = (
  _claims,
  userInfoResponses,
) => {
  const user = userInfoResponses?.user as GithubUser | undefined;
  if (user === undefined) {
    throw new Error("GitHub userinfo response is missing the `user` entry");
  }
  const emails = (userInfoResponses?.emails ?? []) as GithubEmail[];
  const best =
    emails.find((entry) => entry.primary && entry.verified) ??
    emails.find((entry) => entry.verified);
  return {
    id: String(user.id),
    login: user.login,
    name: user.name ?? user.login,
    email: best?.email ?? user.email ?? undefined,
    emailVerified: best !== undefined,
    avatarUrl: user.avatar_url,
  };
};

/** How to talk to GitHub: endpoints, scopes, and the profile mapping. */
const githubCatalog: OauthCatalog = {
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
 * mount:
 *
 * ```ts
 * provider(OauthGithub, {
 *   component: components.oauthGithub,
 *   allowedRedirectOrigins: ["https://app.example.com"],
 * })
 * ```
 *
 * Mount the component under `httpPrefix: "/oauth/github"` in
 * convex.config.ts, binding GitHub's `CLIENT_ID`/`CLIENT_SECRET`, and register
 * `<site-url>/oauth/github/callback` as the redirect URI with GitHub. The
 * mount's prefix alone determines the callback URL.
 *
 * Identity comes from the userinfo endpoints since GitHub returns no id_token.
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
