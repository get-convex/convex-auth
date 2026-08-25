import { RootProvider } from "fumadocs-ui/provider/next";
import { Banner } from "fumadocs-ui/components/banner";
import "./global.css";
import { Inter } from "next/font/google";
import type { Metadata } from "next";
import Link from "next/link";
import { docsRoute } from "@/lib/shared";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // TODO(nicolas) Allow crawlers to index docs
  robots: {
    index: false,
    follow: false,
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>
          <Banner className="bg-orange-100 dark:bg-orange-900 text-orange-900 dark:text-orange-200">
            <p>
              Convex Auth v2{" "}
              <Link href={`${docsRoute}#alpha`} className="underline">
                is in alpha
              </Link>
              . APIs might change at any time, so do not use it in production
              projects yet.
            </p>
          </Banner>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
