import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions()}
      tabs={[
        {
          title: "Convex Auth v2",
          url: "/",
        },
        {
          title: "Convex Auth v1",
          url: "https://labs.convex.dev/auth",
        },
        {
          title: "Convex docs",
          url: "https://docs.convex.dev/",
        },
      ]}
    >
      {children}
    </DocsLayout>
  );
}
