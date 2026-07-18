/**
 * CI fixture-purity check.
 *
 * Walks scenarios/**\/*.json and asserts that no fixture
 * contains runtime-only fields or LLM bypass hooks.
 * Runtime state belongs in canonical journals and snapshots, not in committed
 * fixture files.
 *
 * Exits 1 with the offending file path on any violation.
 */

import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import {
  AGENT_FRAMEWORK_HOST_EXTENSION_ID,
  inspectAgentFrameworkHostCommandDigest,
} from "../src/effects/host-command.js";
import {
  AGENT_FRAMEWORK_COMMITTED_BEHAVIOR_SOURCES,
  isAgentFrameworkLiveBehaviorCommand,
} from "../src/effects/scenario-behavior.js";

const thisFile = url.fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), "..");
const scenariosRoot = path.join(repoRoot, "scenarios");
const writeDigests = process.argv.includes("--write-digests");
const currentSchemaDigest = fs.readFileSync(
  path.join(repoRoot, "src/scenario/protocol/generated/schema-digest.txt"),
  "utf8",
).trim();

const BANNED_KEYS = [
  "expectation_reality",
  "expectation_reality_last_run_at",
  "llm_stubs",
];
const BEHAVIOR_GROUPS = new Set<string>(AGENT_FRAMEWORK_COMMITTED_BEHAVIOR_SOURCES);
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
  const fixture = parsed as Record<string, unknown>;
  const relativePath = path.relative(scenariosRoot, filePath);
  const group = relativePath.split(path.sep)[0];
  const effects = fixture.effects && typeof fixture.effects === "object"
    ? fixture.effects as Record<string, unknown>
    : {};
  const commands = Array.isArray(fixture.commands) ? fixture.commands : [];
  let fixtureChanged = false;
  let hasLiveBehaviorCommand = false;
  for (const command of commands) {
    if (!command || typeof command !== "object") continue;
    const commandPayload = (command as Record<string, unknown>).payload;
    if (!commandPayload || typeof commandPayload !== "object") continue;
    const payloadRecord = commandPayload as Record<string, unknown>;
    if (
      payloadRecord.type !== "extensionCommand" ||
      payloadRecord.extensionId !== AGENT_FRAMEWORK_HOST_EXTENSION_ID
    ) continue;
    let inspection;
    try {
      inspection = inspectAgentFrameworkHostCommandDigest(payloadRecord.data);
    } catch (error) {
      console.error(`FIXTURE HOST COMMAND VIOLATION: ${relativePath}: ${String(error)}`);
      violations++;
      continue;
    }
    hasLiveBehaviorCommand ||= isAgentFrameworkLiveBehaviorCommand(inspection.command);
    if (!inspection.matches) {
      if (writeDigests) {
        payloadRecord.data = inspection.repairedCommand;
        fixtureChanged = true;
      } else {
        console.error(
          `FIXTURE DIGEST VIOLATION: ${inspection.command.type} ${String(inspection.digestField)} mismatch in ${relativePath}`,
        );
        violations++;
      }
    }
  }
  if (BEHAVIOR_GROUPS.has(group) && effects.mode !== "live") {
    console.error(`FIXTURE BEHAVIOR VIOLATION: ${relativePath} must use effects.mode \"live\"`);
    violations++;
  }
  if (BEHAVIOR_GROUPS.has(group) && !hasLiveBehaviorCommand) {
    console.error(`FIXTURE BEHAVIOR VIOLATION: ${relativePath} must dispatch a canonical host command`);
    violations++;
  }
  if (effects.mode === "deterministic" && effects.outcomes && typeof effects.outcomes === "object") {
    for (const outcome of Object.values(effects.outcomes as Record<string, unknown>)) {
      if (!outcome || typeof outcome !== "object") continue;
      const result = (outcome as Record<string, unknown>).result;
      if (!result || typeof result !== "object") continue;
      const kind = (result as Record<string, unknown>).kind;
      if (kind === "toolPolicyEvaluation" || kind === "hookRuleEvaluation") {
        console.error(`FIXTURE BEHAVIOR VIOLATION: deterministic ${String(kind)} outcome in ${relativePath}`);
        violations++;
      }
    }
  }
  const initialRun = fixture.initialRun;
  const startCommand = initialRun && typeof initialRun === "object"
    ? (initialRun as Record<string, unknown>).startCommand
    : undefined;
  const payload = startCommand && typeof startCommand === "object"
    ? (startCommand as Record<string, unknown>).payload
    : undefined;
  const schemaDigest = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>).schemaDigest
    : undefined;
  if (schemaDigest !== currentSchemaDigest) {
    console.error(
      `FIXTURE SCHEMA VIOLATION: expected ${currentSchemaDigest}, found ${String(schemaDigest)} in ${filePath}`,
    );
    violations++;
  }
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
  if (fixtureChanged) fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

if (violations > 0) {
  process.exit(1);
}
