import { signOutHandler } from "@convex-dev/auth/server";
import { api } from "@/convex/_generated/api";

export const POST = signOutHandler({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  signOut: api.auth.signOut,
});
