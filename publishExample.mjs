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
const packageJSON = JSON.parse(
  fs.readFileSync(path.join(__dirname, "package.json")),
);

const directoryPath = path.join(__dirname, "test");
const repositoryUrl = "git@github.com:get-convex/convex-auth-example.git";

// Create a temporary directory
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "convex-auth-publish-example-"),
);
// const tempDir = "publish";

// Copy the directory to the temporary directory
shell.exec(`rsync -av --exclude 'node_modules' ${directoryPath}/ ${tempDir}/`);

// Navigate to the temporary directory
shell.cd(tempDir);

// Remove lines not belonging in example
shell.exec(
  `find . -type f | xargs perl -i -pe 'if (/\\/\\/ !publish: remove/) { $_ = <>; $_ = "" }'`,
);

// Fix up package.json
shell.exec(
  `perl -i -pe 's#"\\@convex-dev/auth": "file:..",#"\\@convex-dev/auth": "^${packageJSON.version}",#' package.json`,
);
shell.exec(
  `perl -i -pe 's#"convex": "file:../node_modules/convex",#"convex": "^1.12.2",#' package.json`,
);
shell.exec(
  `perl -i -pe 's#"react": "file:../node_modules/react",#"react": "^18.3.0",#' package.json`,
);
shell.exec(
  `perl -i -pe 's#"react-dom": "file:../node_modules/react-dom",#"react-dom": "^18.3.0",#' package.json`,
);

// Remove unneeded files
shell.rm("convex/otp/FakePhone.ts");
shell.rm("convex/*.test.ts");
shell.rm("convex/test.helpers.ts");

// Initialize a new git repo
shell.exec("git init");
shell.exec("git add .");
shell.exec(
  'git commit -m "Published from https://github.com/get-convex/convex-auth"',
);

// Force push to the repository for deploying to Vercel
shell.exec(`git push --force ${repositoryUrl} HEAD:vercel`);

/// Push to main

// Remove base URL handling from links
shell.exec(
  `find src -type f | xargs perl -i -pe 's#\\{import\\.meta\\.env\\.BASE_URL\\}#"/"#'`,
);

// Remove unneeded Vercel config
shell.rm("vercel.json");

// Push
shell.exec("git add .");
shell.exec("git commit --amend -C HEAD");
shell.exec(`git push --force ${repositoryUrl} HEAD:main`);

// Clean up the temporary directory
shell.rm("-rf", tempDir);
