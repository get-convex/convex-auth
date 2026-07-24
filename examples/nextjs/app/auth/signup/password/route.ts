import { passwordSignUp } from "@convex-dev/auth/providers/password/server";
import { auth } from "@/serverAuth";
import { api } from "@/convex/_generated/api";

// The sign-up counterpart of the sign-in route: creates the account, then
// mints the session the same way.
export const POST = auth.signInHandler(
  passwordSignUp(api.auth.signUpWithPassword),
);
