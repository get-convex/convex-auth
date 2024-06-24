import fs from "fs";
import os from "os";
import path from "path";
import shell from "shelljs";
import { fileURLToPath } from "url";

if (!shell.which("git")) {
  shell.echo("Error: Git is not installed.");
  shell.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const directoryPath = path.join(__dirname, "test");
const repositoryUrl = "https://github.com/get-convex/convex-auth-example.git";
const branchName = "main";

// Create a temporary directory
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "convex-auth-publish-example-"),
);

// Copy the directory to the temporary directory
shell.exec(`rsync -av --exclude 'node_modules' ${directoryPath}/ ${tempDir}/`);

// Navigate to the temporary directory
shell.cd(tempDir);

// Initialize a new git repo
shell.exec("git init");
shell.exec("git add .");
shell.exec(
  'git commit -m "Published from https://github.com/get-convex/convex-auth"',
);

// Force push to the repository
shell.exec(`git push --force ${repositoryUrl} HEAD:${branchName}`);

// Clean up the temporary directory
shell.rm("-rf", tempDir);
