import type { ReactNode } from "react";
import { ConvexClientProvider } from "@/src/lib/ConvexClientProvider";
import { convexAuthNextjsAccessToken } from "@/src/lib/convexAuth";

export const metadata = {
  title: "Convex Auth — Next.js SSR",
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // The client starts with the token from the cookie, so it can authenticate
  // to Convex without a refresh.
  const token = await convexAuthNextjsAccessToken();
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>
        <ConvexClientProvider initialToken={token}>
          {children}
        </ConvexClientProvider>
      </body>
    </html>
  );
}
