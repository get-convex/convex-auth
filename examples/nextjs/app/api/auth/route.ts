import { createConvexAuthRouteHandler } from "@/convexAuth";

// The endpoint the client posts to for cookie-based refresh / sign-out /
// stashing a sign-in bundle. It reads the httpOnly refresh cookie and never
// returns the refresh token to the browser.
export const { POST } = createConvexAuthRouteHandler();
