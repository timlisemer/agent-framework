/**
 * CI fixture-purity check.
 *
 * Walks test-harness/fixtures/scenarios/**\/*.json and asserts that no fixture
 * contains the keys "expectation_reality" or "expectation_reality_last_run_at".
 * Those fields belong in the runtime sidecar (last-run.json) — not in the
 * committed fixture files.
 *
 * Exits 1 with the offending file path on any violation.
 */

import * as fs from "fs";
import * as path from "path";
import * as url from "url";

const thisFile = url.fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), "..");
const scenariosRoot = path.join(repoRoot, "test-harness", "fixtures", "scenarios");

const BANNED_KEYS = ["expectation_reality", "expectation_reality_last_run_at"];

function walkJsonFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      results.push(fullPath);
    }
  }
  return results;
}

let violations = 0;

for (const filePath of walkJsonFiles(scenariosRoot)) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error(`ERROR: failed to parse ${filePath}: ${err}`);
    violations++;
    continue;
  }
  if (typeof parsed !== "object" || parsed === null) continue;
  for (const key of BANNED_KEYS) {
    if (key in (parsed as Record<string, unknown>)) {
      console.error(`FIXTURE PURITY VIOLATION: "${key}" found in ${filePath}`);
      violations++;
    }
  }
}

if (violations > 0) {
  process.exit(1);
}
