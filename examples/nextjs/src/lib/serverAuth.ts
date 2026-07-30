import { setupConvexAuthServer } from "@convex-dev/auth/server";
import { api } from "@/convex/_generated/api";

// The framework-agnostic auth handlers, configured once. The `secure` cookie
// flag is decided here (HTTPS-only in production) and applies to every handler,
// including sign-in. Route files under app/auth/ mount what this returns.
export const auth = setupConvexAuthServer({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  refreshSession: api.auth.refreshSession,
  signOut: api.auth.signOut,
  cookieOptions: { secure: process.env.NODE_ENV === "production" },
});
