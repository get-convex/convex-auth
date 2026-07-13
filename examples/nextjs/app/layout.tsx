import type { ReactNode } from "react";
import { ConvexAuthNextjsServerProvider } from "@/convexAuth";

export const metadata = {
  title: "Convex Auth — Next.js SSR",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif" }}>
        {/* Reads the current token from cookies and seeds the client provider,
            so the browser hydrates already authenticated. */}
        <ConvexAuthNextjsServerProvider>
          {children}
        </ConvexAuthNextjsServerProvider>
      </body>
    </html>
  );
}
