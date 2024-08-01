import { execSync } from "child_process";
import fs from "fs";
import { MarkdownRendererEvent } from "typedoc-plugin-markdown";

/**
 * @param {import('typedoc-plugin-markdown').MarkdownApplication} app
 */
export function load(app) {
  const setupPostprocess = () => {
    app.renderer.postRenderAsyncJobs.push(async (renderer) => {
      const navigation = renderer.navigation;
      // Temporary workaround for https://github.com/typedoc2md/typedoc-plugin-markdown/issues/663
      navigation[0].children = [
        { title: "server", kind: 2, path: "nextjs/server.mdx" },
      ];
      printMeta(navigation, "pages/api_reference");
      execSync("bash process_api_reference.sh");
    });
  };

  setupPostprocess();

  app.renderer.on(MarkdownRendererEvent.END, () => {
    setupPostprocess();
  });
}

const sortLast = new Set(["nextjs", "providers", "ConvexCredentials"]);

function printMeta(navigation, path) {
  let meta = {};

  const sorted = [...navigation];
  sorted.sort((a, b) => {
    if (sortLast.has(a.title)) {
      return 1;
    }
    if (sortLast.has(b.title)) {
      return -1;
    }
    return 0;
  });

  for (const { title, children } of sorted) {
    meta[title] = title;
    if (children) {
      printMeta(children, path + "/" + title);
    }
  }

  fs.writeFileSync(path + "/_meta.json", JSON.stringify(meta));
}
