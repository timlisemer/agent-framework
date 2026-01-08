/**
 * Version module - generates version string from git commit count
 *
 * Version format: {major}.{minor}.{commit_count}
 * - major/minor from package.json
 * - commit_count from git rev-list --count HEAD
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Get base version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8")
);
const [major, minor] = pkg.version.split(".");

// Get git commit count for patch version
function getCommitCount(): number {
  try {
    return parseInt(
      execSync("git rev-list --count HEAD", { encoding: "utf-8" }).trim(),
      10
    );
  } catch {
    return 0;
  }
}

export const VERSION = `${major}.${minor}.${getCommitCount()}`;
