import { anonymous } from "@convex-dev/auth/providers/anonymous/server";
import { auth } from "@/serverAuth";
import { api } from "@/convex/_generated/api";

// Runs anonymous sign-in on the server: mints the session, moves the refresh
// token into an httpOnly cookie, and returns only the access-only bundle.
export const POST = auth.signInHandler(anonymous(api.auth.signInAnonymous));
