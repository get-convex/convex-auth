/**
 * The app's single Convex Auth Next.js configuration. Everything server-side
 * (middleware, the auth route handler, the token accessor, the server provider)
 * comes from here so the deployment URL and the app's mutation references are
 * declared once.
 *
 * This module is server-only (no `"use client"`); import it from `middleware.ts`,
 * route handlers, and Server Components — never from a Client Component.
 */
import { setupConvexAuthNextjs } from "@convex-dev/auth/nextjs/server";
import { api } from "@/convex/_generated/api";

export const {
  convexAuthNextjsMiddleware,
  nextjsMiddlewareRedirect,
  createConvexAuthRouteHandler,
  convexAuthNextjsToken,
  isAuthenticatedNextjs,
  ConvexAuthNextjsServerProvider,
} = setupConvexAuthNextjs({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  api: {
    refreshSession: api.auth.refreshSession,
    signOut: api.auth.signOut,
  },
});
