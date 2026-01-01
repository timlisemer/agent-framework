import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { existsSync, lstatSync, readlinkSync } from "fs";

/**
 * Load .env from the project root, following symlinks to find the real location.
 * This ensures env vars are loaded even when scripts are symlinked elsewhere.
 */
function findProjectRoot(startPath: string): string {
  let currentPath = startPath;

  // If it's a symlink, resolve to the real path
  try {
    if (lstatSync(currentPath).isSymbolicLink()) {
      currentPath = readlinkSync(currentPath);
      if (!currentPath.startsWith("/")) {
        currentPath = resolve(dirname(startPath), currentPath);
      }
    }
  } catch {
    // Not a symlink or doesn't exist, continue with original
  }

  // Go up from dist/*/file.js to project root
  let dir = dirname(currentPath);
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, ".env"))) {
      return dir;
    }
    if (existsSync(resolve(dir, "package.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }

  return dirname(currentPath);
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = findProjectRoot(scriptPath);
const envPath = resolve(projectRoot, ".env");

if (existsSync(envPath)) {
  config({ path: envPath, quiet: true });
  console.error("[agent-framework] env loaded");
}
