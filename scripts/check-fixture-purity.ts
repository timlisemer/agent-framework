/**
 * CI fixture-purity check.
 *
 * Walks test-harness/fixtures/scenarios/**\/*.json and asserts that no fixture
 * contains runtime-only fields or LLM bypass hooks.
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
const scenariosRoot = path.join(repoRoot, "scenarios");

const BANNED_KEYS = [
  "expectation_reality",
  "expectation_reality_last_run_at",
  "llm_stubs",
];
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
  const raw = fs.readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: failed to parse ${filePath}: ${err}`);
    violations++;
    continue;
  }
  if (typeof parsed !== "object" || parsed === null) continue;
  const stack: unknown[] = [parsed];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (BANNED_KEYS.includes(key)) {
        console.error(`FIXTURE PURITY VIOLATION: "${key}" found in ${filePath}`);
        violations++;
      }
      if (value && typeof value === "object") stack.push(value);
    }
  }
}

if (violations > 0) {
  process.exit(1);
}
