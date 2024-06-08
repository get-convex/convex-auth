import { execSync } from "child_process";
import fs from "fs";

/**
 * @param {import('typedoc-plugin-markdown').MarkdownApplication} app
 */
export function load(app) {
  app.renderer.postRenderAsyncJobs.push(async (renderer) => {
    const navigation = renderer.navigation;
    printMeta(navigation, "pages/api_reference");
    execSync("bash process_api_reference.sh");
  });
}

const sortLast = new Set(["providers", "ConvexCredentials"]);

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
