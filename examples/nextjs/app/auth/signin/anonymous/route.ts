import { anonymousSignInHandler } from "@convex-dev/auth/providers/anonymous/server";
import { api } from "@/convex/_generated/api";

// Runs anonymous sign-in on the server: mints the session, moves the refresh
// token into an httpOnly cookie, and returns only the access-only bundle.
export const POST = anonymousSignInHandler({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  signIn: api.auth.signInAnonymous,
});
