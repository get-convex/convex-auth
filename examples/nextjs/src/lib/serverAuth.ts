import { anonymousRoutes } from "@convex-dev/auth/providers/anonymous/server";
import { passwordRoutes } from "@convex-dev/auth/providers/password/server";
import { setupConvexAuthServer } from "@convex-dev/auth/server";
import { api } from "@/convex/_generated/api";

// The framework-agnostic auth handlers, configured once. The `secure` cookie
// flag is decided here (HTTPS-only in production) and applies to every handler,
// including sign-in. Each provider entry registers its sign-in routes at their
// conventional subpaths, which the catch-all route in app/auth/[...convexAuth]
// serves alongside the built-in refresh and signout routes.
export const auth = setupConvexAuthServer({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  refreshSession: api.auth.refreshSession,
  signOut: api.auth.signOut,
  cookieOptions: { secure: process.env.NODE_ENV === "production" },
  providers: [
    passwordRoutes({
      signIn: api.auth.signInWithPassword,
      signUp: api.auth.signUpWithPassword,
    }),
    anonymousRoutes(api.auth.signInAnonymous),
  ],
});
