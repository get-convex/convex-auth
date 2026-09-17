// Adapts typedoc-plugin-markdown output to Fumadocs: the page title lives in
// frontmatter, and links point at the final site URLs instead of `.md` files.
import path from "node:path";
import { MarkdownPageEvent } from "typedoc-plugin-markdown";

const siteBase = "/api";

export function load(app) {
  app.renderer.on(MarkdownPageEvent.BEGIN, (page) => {
    const model = page.model;
    const title = model.isProject() ? "API Reference" : model.name;
    page.frontmatter = { title, ...page.frontmatter };
  });

  app.renderer.on(MarkdownPageEvent.END, (page) => {
    const pageDir = path.posix.dirname(page.url);
    page.contents = page.contents.replace(
      /\]\(([^)\s:#]+\.md)(#[^)]*)?\)/g,
      (_, target, hash = "") => {
        const resolved = path.posix
          .join(pageDir, target)
          .replace(/\.md$/, "")
          .replace(/(^|\/)index$/, "");
        const url = resolved ? `${siteBase}/${resolved}` : siteBase;
        return `](${url}${hash})`;
      },
    );
  });
}
