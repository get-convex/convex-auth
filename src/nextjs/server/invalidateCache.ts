"use server";

import { cookies } from "next/headers";

export async function invalidateCache() {
  // Dummy cookie, just to set the header which will invalidate
  // the client Router Cache.
  (await cookies()).delete(
    `__convexAuthCookieForRouterCacheInvalidation${Date.now()}`,
  );
  return null;
}
