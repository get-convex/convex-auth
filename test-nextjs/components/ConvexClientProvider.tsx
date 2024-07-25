"use client";

import {
  ConvexAuthNextjsProvider,
  ConvexAuthServerState,
} from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";
import { ReactNode } from "react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!, {
  verbose: true,
});

export default function ConvexClientProvider({
  authServerState,
  children,
}: {
  authServerState: ConvexAuthServerState;
  children: ReactNode;
}) {
  return (
    <ConvexAuthNextjsProvider client={convex} serverState={authServerState}>
      {children}
    </ConvexAuthNextjsProvider>
  );
}
