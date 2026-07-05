import { ConvexReactClient } from "convex/react";

const convexUrl = import.meta.env.VITE_CONVEX_URL as string;

export const convex = new ConvexReactClient(convexUrl);

/**
 * The deployment's HTTP-actions origin, where the auth components' routes
 * live. `npx convex dev` writes `VITE_CONVEX_SITE_URL` for local deployments;
 * for cloud deployments it's derived from the `.convex.cloud` URL.
 */
export const convexSiteUrl: string =
  (import.meta.env.VITE_CONVEX_SITE_URL as string | undefined) ??
  convexUrl.replace(/\.convex\.cloud$/, ".convex.site");
