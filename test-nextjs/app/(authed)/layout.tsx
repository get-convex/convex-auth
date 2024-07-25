import ConvexClientProvider from "@/components/ConvexClientProvider";
import { convexAuthNextjsServerState } from "@convex-dev/auth/nextjs/server";
import { ReactNode } from "react";

export default function AuthedLayout({ children }: { children: ReactNode }) {
  return (
    <ConvexClientProvider authServerState={convexAuthNextjsServerState()}>
      {children}
    </ConvexClientProvider>
  );
}
