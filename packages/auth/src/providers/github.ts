/**
 * GitHub OAuth provider.
 *
 * ```ts
 * import { github } from "@robelest/convex-auth/providers/github";
 *
 * github({
 *   clientId: env.AUTH_GITHUB_ID!,
 *   clientSecret: env.AUTH_GITHUB_SECRET!,
 * })
 * ```
 *
 * @module
 */

import { GitHub as ArcticGitHub } from "arctic";

import { createArcticOAuthClient, createOAuthProvider } from "../server/oauth/factory";
import { defaultOAuthRedirectUri } from "./redirect";

const DEFAULT_SCOPES = ["user:email"];

type GitHubUser = {
  id: number | string;
  name?: string | null;
  avatar_url?: string | null;
  email?: string | null;
};

type GitHubEmail = {
  email?: string | null;
  primary?: boolean;
  verified?: boolean;
};

/** Configuration for the {@link github} provider. */
export interface GitHubConfig {
  /** OAuth app client ID from GitHub. */
  clientId: string;
  /** OAuth app client secret from GitHub. */
  clientSecret: string;
  /** Optional callback URL override. Defaults to the auth site URL plus `/callback/github`. */
  redirectUri?: string;
  /** Optional OAuth scopes. Defaults to `user:email`. */
  scopes?: string[];
  /** Account-linking strategy for existing users with matching email addresses. */
  accountLinking?: "verifiedEmail" | "none";
  /** On returning sign-in, refresh `User.name`/`image`/`email` from the new profile. Defaults to `true`. */
  updateProfileOnLogin?: boolean;
}

/**
 * Create a GitHub OAuth provider.
 *
 * GitHub is not OIDC by default, so this wrapper fetches the profile and email
 * data for you after the OAuth code exchange.
 *
 * @param config - GitHub OAuth client settings.
 * @returns A configured GitHub OAuth provider for `defineAuth`.
 * @throws {Error} When no callback URL can be derived and `redirectUri` is omitted.
 *
 * @example
 * ```ts
 * import { github } from "@robelest/convex-auth/providers/github";
 *
 * github({
 *   clientId: env.AUTH_GITHUB_ID!,
 *   clientSecret: env.AUTH_GITHUB_SECRET!,
 * })
 * ```
 */
export function github(config: GitHubConfig) {
  const scopes = config.scopes ?? DEFAULT_SCOPES;
  const createProvider = (redirectUri?: string) =>
    new ArcticGitHub(
      config.clientId,
      config.clientSecret,
      config.redirectUri ?? defaultOAuthRedirectUri("github", redirectUri),
    );
  return createOAuthProvider({
    id: "github",
    provider: createArcticOAuthClient(createProvider, { pkce: "never" }),
    scopes,
    accountLinking: config.accountLinking,
    updateProfileOnLogin: config.updateProfileOnLogin,
    profile: async (tokens) => {
      if (!tokens.accessToken) {
        throw new Error("GitHub OAuth response is missing access_token.");
      }
      const accessToken = tokens.accessToken;
      const [userResponse, emailResponse] = await Promise.all([
        fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        fetch("https://api.github.com/user/emails", {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      ]);

      if (!userResponse.ok) {
        throw new Error(`GitHub profile request failed: ${userResponse.status}`);
      }
      if (!emailResponse.ok) {
        throw new Error(`GitHub email request failed: ${emailResponse.status}`);
      }

      const user = (await userResponse.json()) as GitHubUser;
      const emails = (await emailResponse.json()) as GitHubEmail[];
      const primaryEmail =
        emails.find((email) => email.primary)?.email ??
        emails.find((email) => email.verified)?.email ??
        user.email ??
        undefined;
      const verifiedEmail =
        emails.find((email) => email.primary)?.verified ??
        emails.find((email) => email.verified)?.verified ??
        false;

      const allEmails = emails
        .filter((e): e is GitHubEmail & { email: string } => typeof e.email === "string")
        .map((e) => ({
          email: e.email,
          primary: e.primary === true,
          verified: e.verified === true,
        }));

      return {
        id: String(user.id),
        email: typeof primaryEmail === "string" ? primaryEmail : undefined,
        emails: allEmails.length > 0 ? allEmails : undefined,
        emailVerified: verifiedEmail,
        name: typeof user.name === "string" ? user.name : undefined,
        image: typeof user.avatar_url === "string" ? user.avatar_url : undefined,
      };
    },
  });
}
