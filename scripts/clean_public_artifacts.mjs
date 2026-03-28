import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  "dist",
  "src-tauri/target",
  "sync-server/dist",
];

for (const target of targets) {
  const fullPath = path.resolve(rootDir, target);
  if (!fs.existsSync(fullPath)) {
    continue;
  }

  fs.rmSync(fullPath, { recursive: true, force: true });
  console.log(`removed ${target}`);
}

console.log("public cleanup finished");
