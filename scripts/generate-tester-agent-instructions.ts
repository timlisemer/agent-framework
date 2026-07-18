import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { synchronizeGeneratedFiles } from "./lib/generated-files.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "adapters/shared/tester-workflow.md");
const workflow = (await fs.readFile(sourcePath, "utf8")).trim();
const tomlWorkflow = escapeTomlMultilineBasicString(workflow);
const generated = new Map<string, string>([
  ["adapters/claude/dotclaude/agents/tester.md", `---
name: tester
description: Runs canonical Scenario fixtures and investigates runtime or rule regressions
tools: [Read, Bash, Write, Edit, MultiEdit, mcp__agent-framework__scenario_tester]
model: opus
---

<!-- Generated from adapters/shared/tester-workflow.md. -->

# Scenario Fixture Tester

${workflow}
`],
  ["adapters/codex/dotcodex/agents/tester.toml", `# Generated from adapters/shared/tester-workflow.md.
name = "tester"
description = "Runs canonical Scenario fixtures and investigates runtime or rule regressions."
model = "gpt-5.5"
model_reasoning_effort = "xhigh"
developer_instructions = """
${tomlWorkflow}
"""
`],
]);

function escapeTomlMultilineBasicString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"""', '\\"""')
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}

await synchronizeGeneratedFiles({
  root,
  files: generated,
  check: process.argv.includes("--check"),
  staleMessage: (stale) => `Generated tester instructions are stale: ${stale.join(", ")}`,
});
