import {
  convexAuthNextjsMiddleware,
  nextjsMiddlewareRedirect,
} from "@/convexAuth";

/**
 * Refreshes the session on every navigation (rotating cookies) and gates the
 * app: signed-out users are sent to `/signin`, and signed-in users are kept off
 * it. The refresh token stays in an httpOnly cookie throughout.
 */
export default convexAuthNextjsMiddleware(
  async (request, { isAuthenticated }) => {
    const isSignInPage = request.nextUrl.pathname === "/signin";
    const authed = await isAuthenticated();
    if (!isSignInPage && !authed) {
      return nextjsMiddlewareRedirect(request, "/signin");
    }
    if (isSignInPage && authed) {
      return nextjsMiddlewareRedirect(request, "/");
    }
  },
);

export const config = {
  // Run on everything except Next internals, static assets, and the auth API
  // route (which manages cookies itself).
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
