"use client";

import { useConvexAuth } from "convex/react";
import { redirect, RedirectType } from "next/navigation";

// Redirect the user back home if they get signed out
// from another tab or server-side.
export default function Error({ error }: { error: Error }) {
  const { isAuthenticated } = useConvexAuth();
  if (isAuthenticated) {
    throw error;
  }
  redirect("/", RedirectType.push);
}
