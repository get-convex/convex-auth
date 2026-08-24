import { NextRequest, NextResponse } from "next/server";
import { isMarkdownPreferred, rewritePath } from "fumadocs-core/negotiation";
import { docsContentRoute } from "@/lib/shared";

// The docs live at the site root, so the patterns start with `/{*path}` and
// not `/docs{/*path}` (the shape the Fumadocs examples use).
const { rewrite: rewriteDocs } = rewritePath(
  `/{*path}`,
  `${docsContentRoute}/{*path}/content.md`,
);
const { rewrite: rewriteSuffix } = rewritePath(
  `/{*path}.md`,
  `${docsContentRoute}/{*path}/content.md`,
);

// Route handlers that serve their own content. The negotiation must not
// rewrite them, or agents get a 404 instead of the file they asked for.
const nonDocsRoutes = ["/api", "/og"];

/**
 * Tell if the path can be a docs page. Docs page paths have no file extension,
 * which keeps files such as `/llms-full.txt` and `/robots.txt` out.
 */
function isDocsPage(pathname: string) {
  if (nonDocsRoutes.some((route) => pathname.startsWith(route))) {
    return false;
  }
  return !pathname.split("/").pop()!.includes(".");
}

/**
 * Serve the Markdown source of a docs page to clients that ask for it, either
 * with a `.md` suffix on the page URL or with an `Accept: text/markdown`
 * header. Agents and other non-browser readers get the code blocks this way.
 */
export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith(docsContentRoute)) {
    return NextResponse.next();
  }

  const suffixed = rewriteSuffix(pathname);
  if (suffixed) {
    return NextResponse.rewrite(new URL(suffixed, request.nextUrl));
  }

  if (isDocsPage(pathname) && isMarkdownPreferred(request)) {
    // The index page has an empty `path`, which the rewrite would turn into
    // `//content.md`. Serve its Markdown from the content route directly.
    const negotiated =
      pathname === "/"
        ? `${docsContentRoute}/content.md`
        : rewriteDocs(pathname);
    if (negotiated) {
      return NextResponse.rewrite(new URL(negotiated, request.nextUrl));
    }
  }

  return NextResponse.next();
}
