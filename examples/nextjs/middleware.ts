import {
  convexAuthNextjsMiddleware,
  nextjsMiddlewareRedirect,
} from "@/convexAuth";

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
  // Run on everything except the /auth handlers (they own their own cookies)
  // and Next internals.
  matcher: ["/((?!auth|_next/static|_next/image|favicon.ico).*)"],
};
