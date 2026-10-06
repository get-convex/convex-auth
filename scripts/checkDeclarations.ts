#!/usr/bin/env tsx
// Checks the declarations that `@convex-dev/auth` publishes. Run it after
// `pnpm build`, because it reads `packages/core/dist/`.
//
// `stripInternal` removes the declarations tagged `@internal` from `dist/`,
// but it keeps the references to them. A public signature that uses an
// `@internal` type thus refers to a name that does not exist, and `tsc` does
// not report it. A consumer with `skipLibCheck` gets `any` and no error. This
// script typechecks the emitted declarations, and it finds these references.
//
// It also makes sure that each `exports` entry with a `types` target has the
// `convex-auth-internal-types` condition first, pointing to the same file in
// `dist/internal-types/`.
//
// Usage: pnpm check:declarations

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = join(root, "packages", "core");
const distDir = join(coreDir, "dist");
const internalCondition = "convex-auth-internal-types";

const errors: string[] = [];

type ExportTarget = string | null | { [condition: string]: ExportTarget };

const pkg = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8")) as {
  exports: Record<string, ExportTarget>;
};
for (const [key, target] of Object.entries(pkg.exports)) {
  if (target === null || typeof target !== "object") continue;
  if (typeof target.types !== "string") continue;
  const expected = target.types.replace(
    /^\.\/dist\//,
    "./dist/internal-types/",
  );
  const internal = target[internalCondition];
  const internalTypes =
    internal !== null && typeof internal === "object" ? internal.types : null;
  if (Object.keys(target)[0] !== internalCondition) {
    // Conditions match in key order, thus `types` would win if it came first.
    errors.push(
      `exports["${key}"]: "${internalCondition}" must be the first condition.`,
    );
  } else if (internalTypes !== expected) {
    errors.push(
      `exports["${key}"]: "${internalCondition}" must be { "types": "${expected}" }.`,
    );
  }
}

function declarationFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".d.ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

// The options of a typical consumer. No `types`: the declarations must not
// need `@types/node` or `vite/client`.
const program = ts.createProgram(declarationFiles(distDir), {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ESNext,
  lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  types: [],
  skipLibCheck: false,
});

// The declarations of some dependencies (for example `next`) do not
// typecheck on their own. Only the files in `dist/` are reported.
const diagnostics = program
  .getSourceFiles()
  .filter((file) => resolve(file.fileName).startsWith(distDir + sep))
  .flatMap((file) => [
    ...program.getSyntacticDiagnostics(file),
    ...program.getSemanticDiagnostics(file),
  ]);
if (diagnostics.length > 0) {
  errors.push(
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("The declarations of @convex-dev/auth are correct.");
