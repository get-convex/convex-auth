// Adapts typedoc-plugin-markdown output to Fumadocs: the page title lives in
// frontmatter, and links point at the final site URLs instead of `.md` files.
import path from "node:path";
import { Comment, Converter, ReflectionKind } from "typedoc";
import { MarkdownPageEvent } from "typedoc-plugin-markdown";

const siteBase = "/api";

export function load(app) {
  // Many public types are declared as `Infer<typeof someValidator>`, and the
  // validator is not exported. TypeDoc renders a type alias as written, so
  // these pages would only show `Infer<typeof someValidator>`. The
  // `@useDeclaredType` modifier makes TypeDoc render the type that TypeScript
  // resolves instead, which lists the fields. TypeDoc reads the modifier right
  // after this event, before it converts the type.
  app.converter.on(
    Converter.EVENT_CREATE_DECLARATION,
    (context, reflection) => {
      if (!reflection.kindOf(ReflectionKind.TypeAlias)) return;
      const declaration = context
        .getSymbolFromReflection(reflection)
        ?.declarations?.find((d) => d.type !== undefined);
      if (declaration?.type?.typeName?.getText() !== "Infer") return;
      reflection.comment ??= new Comment();
      reflection.comment.modifierTags.add("@useDeclaredType");
    },
  );

  app.renderer.on(MarkdownPageEvent.BEGIN, (page) => {
    const model = page.model;
    const title = model.isProject() ? "API reference" : model.name;
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
