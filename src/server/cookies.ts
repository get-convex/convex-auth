import { isLocalHost } from "./utils.js";

export const SHARED_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "none" as const,
  secure: true,
  path: "/",
  partitioned: true,
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
