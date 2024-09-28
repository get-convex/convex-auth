import { fileURLToPath } from "url";
import path from "path";
import fs from "fs-extra";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function moveDirectories() {
  try {
    const srcReact = path.join(__dirname, "distreact", "react");
    const destReact = path.join(__dirname, "dist", "react");

    const srcNextjs = path.join(__dirname, "distnextjs", "nextjs");
    const destNextjs = path.join(__dirname, "dist", "nextjs");

    if (await fs.pathExists(srcReact)) {
      await fs.move(srcReact, destReact, { overwrite: true });
      console.log("Moved React directory.");
    }

    if (await fs.pathExists(srcNextjs)) {
      await fs.move(srcNextjs, destNextjs, { overwrite: true });
      console.log("Moved Next.js directory.");
    }

    await fs.remove(path.join(__dirname, "distreact"));
    await fs.remove(path.join(__dirname, "distnextjs"));
    console.log("Cleaned up source directories.");
  } catch (err) {
    console.error("Error moving directories:", err);
  }
}

moveDirectories();
