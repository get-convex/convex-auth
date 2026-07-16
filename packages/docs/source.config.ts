import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
import type { ShikiTransformer } from "shiki";
import type { Element, ElementContent } from "hast";

// You can customize Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

/**
 * Highlight full-line ranges in a code block based on the *content* of the
 * lines rather than (brittle) line numbers, so highlights survive edits to the
 * included source files.
 *
 * Usage in code block meta:
 *   highlight="single line anchor"          → highlights the line containing it
 *   highlight="start anchor...end anchor"   → highlights the block from the
 *                                             first line containing `start` down
 *                                             to the first following line whose
 *                                             trimmed text equals `end`
 *
 * The attribute may be repeated to highlight several ranges.
 */
function transformerHighlightRanges(): ShikiTransformer {
  const getText = (node: ElementContent): string => {
    if (node.type === "text") return node.value;
    if (node.type === "element") return node.children.map(getText).join("");
    return "";
  };

  return {
    name: "convex-auth:highlight-ranges",
    code(root) {
      const raw = this.options.meta?.__raw;
      if (!raw) return;

      const ranges = [...raw.matchAll(/highlight="([^"]*)"/g)].map((m) => {
        const [start, end] = m[1].split("...");
        return { start: start.trim(), end: end?.trim() };
      });
      if (ranges.length === 0) return;

      const lines = root.children.filter(
        (child): child is Element =>
          child.type === "element" && child.tagName === "span",
      );
      const text = lines.map(getText);

      const title = this.options.meta?.title;
      const where = typeof title === "string" ? ` (code block "${title}")` : "";
      const fail = (message: string): never => {
        throw new Error(`[highlight] ${message}${where}`);
      };

      for (const { start, end } of ranges) {
        // The start anchor must identify exactly one line, so a highlight can
        // never silently match nothing (a typo) or the wrong line (ambiguous).
        const startMatches = text.flatMap((line, i) =>
          line.includes(start) ? [i] : [],
        );
        if (startMatches.length === 0) fail(`pattern "${start}" was not found`);
        if (startMatches.length > 1)
          fail(
            `pattern "${start}" matched ${startMatches.length} lines, expected exactly one`,
          );
        const startIdx = startMatches[0];

        let endIdx = startIdx;
        if (end) {
          const endMatches = text.flatMap((line, i) =>
            i >= startIdx && line.trim() === end ? [i] : [],
          );
          if (endMatches.length === 0)
            fail(`end pattern "${end}" was not found after "${start}"`);
          if (endMatches.length > 1)
            fail(
              `end pattern "${end}" matched ${endMatches.length} lines after "${start}", expected exactly one`,
            );
          endIdx = endMatches[0];
        }

        for (let i = startIdx; i <= endIdx; i++) {
          this.addClassToHast(lines[i], "highlighted");
        }
      }
    },
  };
}

/**
 * Strip a single trailing newline from the code before highlighting, so files
 * that end with a trailing newline (as most do) don't render an empty final
 * line in the code block.
 */
function transformerTrimTrailingNewline(): ShikiTransformer {
  return {
    name: "convex-auth:trim-trailing-newline",
    preprocess(code) {
      return code.replace(/\n$/, "");
    },
  };
}

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      ...rehypeCodeDefaultOptions,
      transformers: [
        ...(rehypeCodeDefaultOptions.transformers ?? []),
        transformerTrimTrailingNewline(),
        transformerHighlightRanges(),
      ],
    },
  },
});
