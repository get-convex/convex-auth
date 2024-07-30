import ConvexClientProvider from "@/components/ConvexClientProvider";
import { cn } from "@/lib/utils";
import { ChatBubbleIcon, HomeIcon, ReaderIcon } from "@radix-ui/react-icons";
import Link from "next/link";
import { ReactNode } from "react";

export default async function ProductLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <ConvexClientProvider>
      <div className="flex min-h-screen w-full">
        <ProductMenu />
        {children}
      </div>
    </ConvexClientProvider>
  );
}

function ProductMenu() {
  return (
    <aside className="w-48 border-r bg-muted/40 p-2">
      <nav className="flex h-full max-h-screen flex-col gap-2">
        <MenuLink href="/product" active>
          <ChatBubbleIcon className="h-4 w-4" />
          Chat
        </MenuLink>

        <MenuLink href="https://docs.convex.dev">
          <ReaderIcon className="h-4 w-4" />
          Docs
        </MenuLink>
        <MenuLink href="/">
          <HomeIcon className="h-4 w-4" />
          Home
        </MenuLink>
      </nav>
    </aside>
  );
}

function MenuLink({
  active,
  href,
  children,
}: {
  active?: boolean;
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium  text-muted-foreground transition-all hover:text-primary",
        active && "bg-muted text-primary",
      )}
    >
      {children}
    </Link>
  );
}
