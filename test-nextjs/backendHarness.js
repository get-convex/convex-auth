// Run a command against a fresh local backend, handling setting up and tearing down the backend.
// If CONVEX_LOCAL_BACKEND_PATH is set, expect a convex local backend repo and use that.
// Otherwise download the latest prebuild binary.
//
// Based on from https://github.com/get-convex/convex-chess/blob/main/backendHarness.js
// and
// https://github.com/get-convex/convex-js/blob/main/src/cli/lib/localDeployment/run.ts

const http = require("http");
const fsPromises = require("fs/promises");
const { spawn, exec, execSync } = require("child_process");
const { existsSync, unlinkSync } = require("fs");
const { Readable } = require("stream");
const AdmZip = require("adm-zip");
const { promisify } = require("util");

function logToStderr(...args) {
  const strings = args.map((arg) =>
    typeof arg === "string"
      ? arg
      : util.inspect(arg, {
          colors: true,
          depth: null,
          maxArrayLength: null,
          breakLength: process.stdout.columns || 80,
        }),
  );

  process.stderr.write(strings.join(" ") + "\n");
}

// Checks for a local backend running on port 3210.
const backendCloudPort = 3210;
const backendSitePort = 3211;
const parsedUrl = new URL(`http://127.0.0.1:${backendCloudPort}`);

async function isBackendRunning(backendUrl) {
  return new Promise((resolve) => {
    http
      .request(
        {
          hostname: backendUrl.hostname,
          port: backendUrl.port,
          path: "/version",
          method: "GET",
        },
        (res) => {
          resolve(res.statusCode === 200);
        },
      )
      .on("error", () => {
        resolve(false);
      })
      .end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const waitForLocalBackendRunning = async (backendUrl) => {
  let isRunning = await isBackendRunning(backendUrl);
  let i = 0;
  while (!isRunning) {
    if (i % 10 === 0) {
      // Progress messages every ~5 seconds
      logToStderr("Waiting for backend to be running...");
    }
    await sleep(500);
    isRunning = await isBackendRunning(backendUrl);
    isDead = backendProcess.exitCode !== null;
    if (isDead) {
      throw new Error("Backend exited");
    }
    i += 1;
  }
};

let backendProcess = null;

function cleanup() {
  if (backendProcess !== null) {
    logToStderr("Cleaning up running backend");
    backendProcess.kill("SIGTERM");
    if (useDownloadedBinary) {
      execSync(
        "rm -rf convex_local_storage && rm -f convex_local_backend.sqlite3",
      );
    } else {
      execSync("just reset-local-backend");
    }
  }
}

function getDownloadPath() {
  switch (process.platform) {
    case "darwin":
      if (process.arch === "arm64") {
        return "convex-local-backend-aarch64-apple-darwin.zip";
      } else if (process.arch === "x64") {
        return "convex-local-backend-x86_64-apple-darwin.zip";
      }
      break;
    case "linux":
      if (process.arch === "arm64") {
        return "convex-local-backend-aarch64-unknown-linux-gnu.zip";
      } else if (process.arch === "x64") {
        return "convex-local-backend-x86_64-unknown-linux-gnu.zip";
      }
      break;
    case "win32":
      return "convex-local-backend-x86_64-pc-windows-msvc.zip";
  }
  return null;
}

async function downloadedBinaryProcess() {
  const latest = await fetch(
    "https://github.com/get-convex/convex-backend/releases/latest",
    { redirect: "manual" },
  );
  if (latest.status !== 302) {
    throw new Error(`Error downloading ${latest}`);
  }
  const latestUrl = latest.headers.get("location");
  const version = latestUrl.split("/").pop();
  logToStderr(`Downloading latest backend binary, ${version}`);
  const downloadPath = getDownloadPath();
  const response = await fetch(
    `https://github.com/get-convex/convex-backend/releases/download/${version}/${downloadPath}`,
  );

  const zipLocation = "convex-backend.zip";
  if (existsSync(zipLocation)) {
    unlinkSync(zipLocation);
  }
  const fileHandle = await fsPromises.open(zipLocation, "wx", 0o644);
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      await fileHandle.write(chunk);
    }
  } finally {
    await fileHandle.close();
  }
  logToStderr("Downloaded zip file");

  const zip = new AdmZip(zipLocation);
  zip.extractAllTo(".", true);
  const p = "./convex-local-backend";
  await promisify(exec)(`chmod +x ${p}`);
  return spawn(
    p,
    ["--port", backendCloudPort, "--site-proxy-port", backendSitePort],
    { env: { CONVEX_TRACE_FILE: "1" } },
  );
}

async function runWithLocalBackend(command, backendUrl) {
  if (useDownloadedBinary) {
    console.error(
      "environment variable CONVEX_LOCAL_BACKEND_PATH not set, using prebuild binary",
    );
  }
  const isRunning = await isBackendRunning(backendUrl);
  if (isRunning) {
    console.error(
      "Looks like local backend is already running. Cancel it and restart this command.",
    );
    process.exit(1);
  }

  if (useDownloadedBinary) {
    execSync(
      "rm -rf convex_local_storage && rm -f convex_local_backend.sqlite3",
    );
  } else {
    execSync("just reset-local-backend");
  }
  let logLocation;
  if (useDownloadedBinary) {
    backendProcess = await downloadedBinaryProcess();
    logLocation = `convex-local-backend.log`;
  } else {
    backendProcess = spawn("just", ["run-local-backend"], {
      env: {
        ...process.env,
        CONVEX_TRACE_FILE: "1",
      },
      cwd: process.env.CONVEX_LOCAL_BACKEND_PATH,
    });
    logLocation = `${process.env.CONVEX_LOCAL_BACKEND_PATH}/convex-local-backend.log`;
  }
  backendProcess.stdout.pipe(process.stderr);
  backendProcess.stderr.pipe(process.stderr);

  await waitForLocalBackendRunning(backendUrl);
  logToStderr("Backend running! Logs can be found in", logLocation);
  logToStderr("Running command", command);
  const innerCommand = new Promise((resolve) => {
    const c = spawn(command, {
      shell: true,
      stdio: "pipe",
      env: { ...process.env, FORCE_COLOR: true },
    });
    c.stdout.on("data", (data) => {
      process.stdout.write(data);
    });

    c.stderr.on("data", (data) => {
      process.stderr.write(data);
    });

    c.on("exit", (code) => {
      logToStderr(`inner command exited with code ${code.toString()}`);
      resolve(code);
    });
  });
  return innerCommand;
}

const useDownloadedBinary = process.env.CONVEX_LOCAL_BACKEND_PATH === undefined;

(async function main() {
  let code = undefined;
  try {
    code = await runWithLocalBackend(process.argv[2], parsedUrl);
  } finally {
    cleanup();
  }
  // undefined means exception was thrown
  if (code !== undefined) {
    process.exit(code);
  }
})();
