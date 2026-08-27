#!/usr/bin/env tsx
// Regenerates every `_generated` directory in the monorepo.
//
// The apps and the components are found on disk, thus a new example app or a
// new component is picked up without a change to this script:
//
//   - An app is a workspace package that has a Convex functions directory
//     (`convex/` by default, or the `functions` field of its `convex.json`),
//     other than the component host below.
//   - A component is any other directory that has a `convex.config.ts` file.
//
// Each app runs in its own lane, the components run in a lane of their own, and
// the lanes run at the same time. An interactive terminal shows one live line
// per lane; CI has no TTY, thus Listr writes a plain line for each event
// instead.
//
// `tsx` runs this file, and `pnpm typecheck` checks it against
// `scripts/tsconfig.json`: `tsx` strips the types, it does not check them.
//
// Usage: pnpm codegen [--list] [--serial] [filter ...]
//
// A filter is a substring of a path. Only the apps and the components whose
// path contains one of the filters are regenerated.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Listr } from "listr2";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The app that the components generate their code against, described in
// `scripts/codegen-host/README.md`. It is a workspace package, thus discovery
// finds it like any other app; it generates no code of its own, thus the app
// list leaves it out.
const componentHost = join(root, "scripts", "codegen-host");

// The directories that hold the workspace packages. `pnpm-workspace.yaml` uses
// one `<dir>/*` glob for each of them.
const workspaceRoots = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
  .split("\n")
  .map((line) => /^\s*-\s*"?([^"\s]+)\/\*"?\s*$/.exec(line)?.[1])
  .filter((dir) => dir !== undefined);

const skippedDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  "_generated",
  ".git",
  ".next",
]);

function directoriesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !skippedDirectories.has(entry.name),
    )
    .map((entry) => join(dir, entry.name));
}

// The functions directory of an app, or undefined if the directory is not an
// app. A workspace package that has no `package.json` is a leftover directory,
// not a package.
function functionsDirectory(packageDir: string): string | undefined {
  if (!existsSync(join(packageDir, "package.json"))) return undefined;
  let functions = "convex";
  const configPath = join(packageDir, "convex.json");
  if (existsSync(configPath)) {
    const config: { functions?: string } = JSON.parse(
      readFileSync(configPath, "utf8"),
    );
    functions = config.functions ?? functions;
  }
  const dir = join(packageDir, functions);
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : undefined;
}

function findComponentConfigs(dir: string, found: string[] = []): string[] {
  if (existsSync(join(dir, "convex.config.ts"))) found.push(dir);
  for (const child of directoriesIn(dir)) findComponentConfigs(child, found);
  return found;
}

const apps: { dir: string; functions: string }[] = [];
for (const workspaceRoot of workspaceRoots) {
  for (const packageDir of directoriesIn(join(root, workspaceRoot))) {
    if (packageDir === componentHost) continue;
    const functions = functionsDirectory(packageDir);
    if (functions !== undefined) apps.push({ dir: packageDir, functions });
  }
}
apps.sort((a, b) => a.dir.localeCompare(b.dir));

// Every `convex.config.ts` that is not the app-level config of an app defines a
// component.
const appFunctionDirs = new Set(apps.map((app) => app.functions));
const components = findComponentConfigs(root)
  .filter((dir) => !appFunctionDirs.has(dir))
  .sort((a, b) => a.localeCompare(b));

const args = process.argv.slice(2);
const list = args.includes("--list");
const serial = args.includes("--serial");
const filters = args.filter((arg) => !arg.startsWith("--"));
const selected = (path: string) =>
  filters.length === 0 ||
  filters.some((filter) => relative(root, path).includes(filter));

const selectedApps = apps.filter((app) => selected(app.dir));
const selectedComponents = components.filter(selected);

if (list) {
  console.log("Apps:");
  for (const app of selectedApps) console.log(`  ${relative(root, app.dir)}`);
  console.log("Components:");
  for (const dir of selectedComponents) console.log(`  ${relative(root, dir)}`);
  process.exit(0);
}

type Report = (line: string) => void;

// A terminal redraws one line per lane, thus the live progress of a command is
// worth showing. CI has no TTY, where Listr writes each report as its own line:
// there, only the command itself is worth a line.
const interactive = process.stdout.isTTY === true;

// Runs a Convex command and reports its last output line as it goes. The whole
// output is kept, because a failure has to show it: only the last line is
// visible while the command runs.
function convex(
  cwd: string,
  commandArgs: string[],
  report: Report,
): Promise<{ ok: boolean; output: string }> {
  // The lane title already names the app in a terminal. The verbose renderer
  // writes the lanes interleaved, thus there the line has to name it itself.
  const label = interactive
    ? `convex ${commandArgs.join(" ")}`
    : `${relative(root, cwd)}$ convex ${commandArgs.join(" ")}`;
  report(label);
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["exec", "convex", ...commandArgs], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (!interactive) return;
      const lastLine = text.trimEnd().split("\n").at(-1)?.trim();
      if (lastLine) report(`${label} — ${lastLine}`);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("close", (code) => resolve({ ok: code === 0, output }));
  });
}

// The deployment that an app selects, or undefined if it selects none.
function selectedDeployment(appDir: string): string | undefined {
  if (process.env.CONVEX_DEPLOYMENT) return process.env.CONVEX_DEPLOYMENT;
  for (const file of [".env.local", ".env"]) {
    const path = join(appDir, file);
    if (!existsSync(path)) continue;
    const match = /^\s*CONVEX_DEPLOYMENT=(\S+)/m.exec(
      readFileSync(path, "utf8"),
    );
    if (match) return match[1];
  }
  return undefined;
}

// Two `convex dev` runs that create an anonymous deployment at the same time
// both pick the first free port, and the second one then fails with "A
// different local backend is running on selected port". The lanes thus create
// their deployments one at a time; only the creation is serialized, because the
// commands that follow use the port that the deployment already holds.
let deploymentSetup: Promise<unknown> = Promise.resolve();
function serializeSetup<T>(run: () => Promise<T>): Promise<T> {
  const next = deploymentSetup.then(run, run);
  deploymentSetup = next.catch(() => {});
  return next;
}

class CommandFailed extends Error {
  constructor(label: string, output: string) {
    super(`${label} failed:\n\n${output.trim()}`);
    this.name = "CommandFailed";
  }
}

// `convex codegen` analyzes a deployment, thus each app needs one. An app that
// selects a deployment keeps it, because it is the deployment that somebody
// develops against. An app that selects none, and an app whose anonymous
// deployment is gone, gets an anonymous local deployment. Such a deployment
// needs no credentials and no cloud project, which is what lets CI run this.
async function codegen(
  appDir: string,
  report: Report,
  ...commandArgs: string[]
): Promise<void> {
  const app = relative(root, appDir);
  const args = ["codegen", "--typecheck", "disable", ...commandArgs];
  const deployment = selectedDeployment(appDir);
  let attempt = await convex(appDir, args, report);
  if (attempt.ok) return;
  if (deployment !== undefined && !deployment.startsWith("anonymous:")) {
    throw new Error(
      `${app} selects the deployment ${deployment}, and codegen failed against ` +
        `it. Run \`npx convex dev\` in that directory to select a deployment you ` +
        `have access to, or delete its .env.local to use an anonymous local ` +
        `deployment.\n\n${attempt.output.trim()}`,
    );
  }
  // No deployment, or an anonymous one that is gone: create it and retry.
  const setup = await serializeSetup(() =>
    convex(
      appDir,
      [
        "dev",
        "--once",
        "--skip-push",
        "--codegen",
        "disable",
        "--typecheck",
        "disable",
      ],
      report,
    ),
  );
  if (!setup.ok) throw new CommandFailed(`${app}: convex dev`, setup.output);
  attempt = await convex(appDir, args, report);
  if (!attempt.ok)
    throw new CommandFailed(`${app}: convex codegen`, attempt.output);
}

// The components generate their code against `scripts/codegen-host`, an app
// that exists only for this. Two reasons: codegen pushes to the deployment it
// analyzes, and an empty app keeps that push away from the deployment that
// somebody develops the examples against; and the components then need no
// example app to exist, nor to be installed by one.
//
// The components share that one deployment, thus they run one after the other:
// two pushes to the same deployment race, and one of them fails with an
// OptimisticConcurrencyControlFailure.
type Lane = { title: string; run: (report: Report) => Promise<void> };

const lanes: Lane[] = selectedApps.map((app) => ({
  title: relative(root, app.dir),
  run: (report) => codegen(app.dir, report),
}));

if (selectedComponents.length > 0) {
  lanes.push({
    title: "components",
    run: async (report) => {
      for (const dir of selectedComponents) {
        await codegen(
          componentHost,
          report,
          "--component-dir",
          relative(componentHost, dir),
        );
      }
    },
  });
}

const listr = new Listr(
  lanes.map((lane) => ({
    title: lane.title,
    task: (_context: unknown, task: { output: string }) =>
      lane.run((line) => {
        task.output = line;
      }),
  })),
  {
    concurrent: !serial,
    exitOnError: false,
    collectErrors: true,
    // A terminal shows one live line per lane. CI has no TTY, thus Listr falls
    // back to the verbose renderer, which writes each event as a plain line.
    renderer: "default",
    fallbackRenderer: "verbose",
  },
);

await listr.run();

// Listr has already written each failure, thus the exit code is all that is
// left to report.
if ((listr.errors ?? []).length > 0) process.exit(1);

console.log("\n✔ Codegen complete.");
