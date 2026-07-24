import { passwordSignIn } from "@convex-dev/auth/providers/password/server";
import { auth } from "@/serverAuth";
import { api } from "@/convex/_generated/api";

// Runs password sign-in on the server: reads the credentials off the JSON
// body, runs the sign-in action, moves the refresh token into an httpOnly
// cookie, and returns the access-only bundle — or the action's `userError`.
export const POST = auth.signInHandler(
  passwordSignIn(api.auth.signInWithPassword),
);
