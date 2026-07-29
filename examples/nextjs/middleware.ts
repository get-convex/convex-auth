import {
  convexAuthNextjsMiddleware,
  nextjsMiddlewareRedirect,
} from "@/convexAuth";

// Uses the provided convexAuthNextjsMiddleware function to build a custom middleware handler
// for this example application. As seen here, you supply a custom function that makes routing
// decisions, which gets called with an `isAuthenticated` helper. That allows checking to see
// if the browser request is currently authenticated and thus which page should be rendered
// based on that state and the requested page.
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
