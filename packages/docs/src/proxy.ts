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

/**
 * Serve the Markdown source of a docs page to clients that ask for it, either
 * with a `.md` suffix on the page URL or with an `Accept: text/markdown`
 * header. Agents and other non-browser readers get the code blocks this way.
 */
export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith(docsContentRoute) || pathname.startsWith("/llms.")) {
    return NextResponse.next();
  }

  const suffixed = rewriteSuffix(pathname);
  if (suffixed) {
    return NextResponse.rewrite(new URL(suffixed, request.nextUrl));
  }

  if (isMarkdownPreferred(request)) {
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
