"use client";

import { useConvexAuth } from "convex/react";
import { redirect, RedirectType, useRouter } from "next/navigation";
import { useEffect } from "react";

// Redirect the user back home if they get signed out
// from another tab or server-side.
export default function Error({ error }: { error: Error }) {
  const { isAuthenticated } = useConvexAuth();
  // const router = useRouter();
  if (isAuthenticated) {
    throw error;
  }
  // useEffect(() => {
  //   if (!isAuthenticated) {
  //     router.push("/");
  //   }
  // }, [isAuthenticated, router, error]);
  redirect("/", RedirectType.push);
}
