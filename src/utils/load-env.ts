import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { existsSync, lstatSync, readlinkSync, readFileSync } from "fs";

/**
 * Load .env from the project root, following symlinks to find the real location.
 * This ensures env vars are loaded even when scripts are symlinked elsewhere.
 *
 * For performance, set AGENT_FRAMEWORK_ROOT to skip the expensive FS traversal.
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

function getProjectRoot(): string {
  // Fast path: use explicit env var (avoids 10+ sync FS calls)
  const envRoot = process.env.AGENT_FRAMEWORK_ROOT;
  if (envRoot && existsSync(resolve(envRoot, ".env"))) {
    return envRoot;
  }

  // Slow path: resolve via filesystem (fallback for MCP server, dev mode)
  const scriptPath = fileURLToPath(import.meta.url);
  return findProjectRoot(scriptPath);
}

const projectRoot = getProjectRoot();
const envPath = resolve(projectRoot, ".env");

if (existsSync(envPath)) {
  config({ path: envPath, quiet: true });

  // Fix dotenv bug: it treats # as comment even in unquoted values
  // Re-parse critical env vars that might contain # or other special chars
  const criticalVars = ["AGENT_FRAMEWORK_API_KEY", "POSTGRES_PASSWORD"];
  try {
    const envContent = readFileSync(envPath, "utf-8");
    for (const varName of criticalVars) {
      const match = envContent.match(new RegExp(`^${varName}=(.*)$`, "m"));
      if (match) {
        let value = match[1].trim();
        // Remove surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        process.env[varName] = value;
      }
    }
  } catch {
    // Ignore parse errors, dotenv values are still available
  }
}
