import { refreshHandler } from "@convex-dev/auth/server";
import { api } from "@/convex/_generated/api";

export const POST = refreshHandler({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  refreshSession: api.auth.refreshSession,
});
