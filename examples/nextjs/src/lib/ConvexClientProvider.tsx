"use client";

import {
  ConvexAuthNextjsProvider,
  createNextjsAuthClient,
} from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

// Both clients are built once, at module scope. A Server Component cannot pass
// them to this Client Component, so they live in this file.
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
const auth = createNextjsAuthClient({ convex });

export function ConvexClientProvider({
  initialToken,
  children,
}: {
  /** The access token the root layout read from the cookie. */
  initialToken: string | null;
  children: ReactNode;
}) {
  return (
    <ConvexAuthNextjsProvider auth={auth} initialToken={initialToken}>
      {children}
    </ConvexAuthNextjsProvider>
  );
}
