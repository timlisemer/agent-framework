/**
 * Version module - reads version baked in at build time.
 *
 * Version format: {major}.{minor}.{commit_count}
 * - major/minor from package.json
 * - commit_count written by `just build` into dist/version-data.json
 *
 * At build time the justfile runs a script that writes the commit count.
 * At runtime this module reads the pre-computed value — no git needed.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadVersion(): string {
  let major = "0";
  let minor = "0";
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, candidate), "utf-8"));
      [major, minor] = pkg.version.split(".");
      break;
    } catch {
      // try next candidate
    }
  }

  try {
    const data = JSON.parse(
      readFileSync(join(__dirname, "version-data.json"), "utf-8")
    );
    return `${major}.${minor}.${data.commitCount}`;
  } catch {
    return `${major}.${minor}.0`;
  }
}

export const VERSION = loadVersion();
