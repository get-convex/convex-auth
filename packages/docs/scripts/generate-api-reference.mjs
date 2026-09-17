// Generates the API reference section from the public exports of
// `@convex-dev/auth`. One TypeDoc module per import specifier, e.g.
// `@convex-dev/auth/server`, so the reference mirrors what users import.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Application } from "typedoc";

const docsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const coreDir = path.resolve(docsDir, "../core");
// The shims must live inside the core package: TypeDoc only reports
// unexported types for the package that owns the entry points.
const shimDir = path.join(coreDir, ".api-entrypoints");
const outDir = path.join(docsDir, "content/docs/api");

const pkg = JSON.parse(
  readFileSync(path.join(coreDir, "package.json"), "utf8"),
);

/** Public import specifiers, mapped to the source file that implements them. */
function collectEntryPoints() {
  const entries = new Map();
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (value === null || key === "./package.json" || key.endsWith(".js"))
      continue;
    if (key.includes("_generated")) continue;
    const target = typeof value === "string" ? value : value.types;
    if (!target) continue;
    const srcPattern = target
      .replace(/^\.\/dist\//, "./src/")
      .replace(/\.d\.ts$/, ".ts");
    const specifier = key.slice(2);
    if (!srcPattern.includes("*")) {
      entries.set(specifier, resolveSource(srcPattern));
      continue;
    }
    const [dirPart] = srcPattern.split("*");
    const dir = path.join(coreDir, dirPart);
    for (const file of readdirSync(dir)) {
      const match = /^(.+)\.(ts|tsx)$/.exec(file);
      if (!match) continue;
      const stem = match[1];
      // `x/index` is the same module as `x`, which its own export key covers.
      if (stem.includes(".test") || stem === "index") continue;
      entries.set(specifier.replace("*", stem), path.join(dir, file));
    }
  }
  return entries;
}

function resolveSource(pattern) {
  for (const ext of [".ts", ".tsx"]) {
    const candidate = path.join(coreDir, pattern.replace(/\.ts$/, ext));
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`No source file for ${pattern}`);
}

/** The leading `@module` doc comment of a source file, if it has one. */
function moduleComment(source) {
  const match = /^\s*(\/\*\*[\s\S]*?\*\/)/.exec(source);
  if (!match || !/@(module|packageDocumentation)\b/.test(match[1])) return "";
  return match[1] + "\n";
}

function writeShims(entries) {
  rmSync(shimDir, { recursive: true, force: true });
  const files = [];
  for (const [specifier, src] of entries) {
    const shim = path.join(shimDir, `${specifier}.ts`);
    mkdirSync(path.dirname(shim), { recursive: true });
    let rel = path.relative(path.dirname(shim), src).split(path.sep).join("/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    const source = readFileSync(src, "utf8");
    const lines = [`export * from "${rel}";`];
    if (/^export default /m.test(source))
      lines.push(`export { default } from "${rel}";`);
    writeFileSync(shim, moduleComment(source) + lines.join("\n") + "\n");
    files.push(shim);
  }
  writeFileSync(
    path.join(shimDir, "tsconfig.json"),
    JSON.stringify(
      {
        extends: "../tsconfig.json",
        compilerOptions: { noEmit: true },
        include: ["./**/*.ts", "../src/**/*"],
      },
      null,
      2,
    ) + "\n",
  );
  return files;
}

/**
 * Fumadocs titles a folder after its index page. Folders without one, like
 * `providers` or `classes`, get a `meta.json` so the sidebar label matches the
 * import path instead of a capitalized folder name.
 */
function writeFolderMeta(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (!existsSync(path.join(child, "index.md"))) {
      const kindTitles = {
        classes: "Classes",
        interfaces: "Interfaces",
        enums: "Enums",
      };
      const title = kindTitles[entry.name] ?? entry.name;
      writeFileSync(
        path.join(child, "meta.json"),
        JSON.stringify({ title }, null, 2) + "\n",
      );
    }
    writeFolderMeta(child);
  }
}

const entries = collectEntryPoints();
const entryPoints = writeShims(entries);
console.log(`${entryPoints.length} entry points`);

const app = await Application.bootstrapWithPlugins({
  entryPoints,
  tsconfig: path.join(shimDir, "tsconfig.json"),
  plugin: [
    "typedoc-plugin-markdown",
    "typedoc-plugin-frontmatter",
    path.join(docsDir, "scripts/typedoc-fumadocs-plugin.mjs"),
  ],
  out: outDir,
  cleanOutputDir: true,
  readme: "none",
  name: "@convex-dev/auth",
  excludeInternal: true,
  excludePrivate: true,
  disableSources: true,
  skipErrorChecking: true,
  // Markdown plugin
  entryFileName: "index",
  hidePageHeader: true,
  hideBreadcrumbs: true,
  hidePageTitle: true,
  useCodeBlocks: true,
  parametersFormat: "table",
  interfacePropertiesFormat: "table",
  classPropertiesFormat: "table",
  typeAliasPropertiesFormat: "table",
  membersWithOwnFile: ["Class", "Interface", "Enum"],
});

const project = await app.convert();
if (!project) {
  console.error("TypeDoc conversion failed");
  process.exit(1);
}
// Warns once per type that a public signature references but no entry point
// exports. Readers see those types inlined instead of by name.
app.validate(project);
await app.generateOutputs(project);
writeFileSync(
  path.join(outDir, "meta.json"),
  JSON.stringify({ title: "API reference", root: false }, null, 2) + "\n",
);
writeFolderMeta(outDir);
console.log(`Wrote ${outDir}`);
