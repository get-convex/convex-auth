import { setupConvexAuthNextjs } from "@convex-dev/auth/nextjs/ssr";
import { api } from "@/convex/_generated/api";

// The Next-specific server helpers: proxy (up-front refresh + redirects),
// the Server-Component token accessor, and the provider that hydrates the
// client. The sign-in / refresh / sign-out *route handlers* are mounted
// separately under app/auth/ from the framework-agnostic handlers.
export const {
  convexAuthNextjsProxy,
  nextjsProxyRedirect,
  convexAuthNextjsAccessToken,
  isAuthenticatedNextjs,
  ConvexAuthNextjsServerProvider,
} = setupConvexAuthNextjs({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  refreshSession: api.auth.refreshSession,
  isAuthenticated: api.auth.isAuthenticated,
});
