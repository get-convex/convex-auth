import { isLocalHost } from "./utils.js";

// These options apply to every cookie Convex Auth sets during OAuth flows
// (PKCE code_verifier, state, nonce, redirectTo). They must be carried back
// from the OAuth provider callback to the Convex callback endpoint on the
// same convex.site origin.
//
// Why `sameSite: "lax"` and no `partitioned`:
// - `sameSite: "lax"` still sends the cookie on the top-level navigation
//   initiated by the OAuth provider redirecting back to `/api/auth/callback/*`,
//   which is what all of these cookies need.
// - `sameSite: "none" + partitioned: true` was failing under iOS
//   `ASWebAuthenticationSession` (especially with `preferEphemeralSession:
//   true`) — Safari would not replay the cookie on the return leg after
//   Google, dropping the PKCE verifier, state, nonce, and redirectTo. That
//   manifested as `checkOAuthBodyError` during the Google token exchange and
//   as a fallthrough to `SITE_URL` in the redirect callback. See
//   https://github.com/get-convex/convex-auth/issues/218.
export const SHARED_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: true,
  path: "/",
};

const REDIRECT_MAX_AGE = 60 * 15; // 15 minutes in seconds
export function redirectToParamCookie(providerId: string, redirectTo: string) {
  return {
    name: redirectToParamCookieName(providerId),
    value: redirectTo,
    options: { ...SHARED_COOKIE_OPTIONS, maxAge: REDIRECT_MAX_AGE },
  };
}

export function useRedirectToParam(
  providerId: string,
  cookies: Record<string, string | undefined>,
) {
  const cookieName = redirectToParamCookieName(providerId);
  const redirectTo = cookies[cookieName];
  if (redirectTo === undefined) {
    return null;
  }

  // Clear the cookie
  const updatedCookie = {
    name: cookieName,
    value: "",
    options: { ...SHARED_COOKIE_OPTIONS, maxAge: 0 },
  };

  return { redirectTo, updatedCookie };
}

function redirectToParamCookieName(providerId: string) {
  return (!isLocalHost(process.env.CONVEX_SITE_URL) ? "__Host-" : "") + providerId + "RedirectTo";
}
