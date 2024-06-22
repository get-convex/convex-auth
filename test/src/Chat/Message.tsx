import { cn } from "@/lib/utils";
import { Id } from "convex/_generated/dataModel";
import { ReactNode } from "react";

export function Message({
  authorName,
  author,
  viewer,
  children,
}: {
  authorName: string;
  author: Id<"users">;
  viewer: Id<"users">;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex flex-col text-sm",
        author === viewer ? "items-end self-end" : "items-start self-start",
      )}
    >
      <div className="mb-1 text-sm font-medium">{authorName}</div>
      <p
        className={cn(
          "rounded-xl bg-muted px-3 py-2",
          author === viewer ? "rounded-tr-none" : "rounded-tl-none",
        )}
      >
        {children}
      </p>
    </li>
  );
}
