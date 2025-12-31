import * as fs from "fs";
import * as path from "path";
import { getModelId } from "../../types.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { runCommand } from "../../utils/command.js";
import { logToHomeAssistant } from "../../utils/logger.js";
import { extractTextFromResponse } from "../../utils/response-parser.js";

const SYSTEM_PROMPT = `You are a check tool runner. Your ONLY job is to summarize check results.

Output EXACTLY this format:

## Results
- Errors: <count>
- Warnings: <count>
- Status: PASS | FAIL

## Errors
<Quote each error exactly as it appears in output. Include file:line if present.>

## Warnings
<Quote each warning exactly as it appears in output. Include file:line if present.>

CLASSIFICATION RULES:
1. ERRORS are: compilation failures, type errors, syntax errors, and UNUSED CODE warnings
2. WARNINGS are: style suggestions, lints, refactoring hints (like "if can be collapsed")
3. Unused code (unused variables, functions, imports, dead code) counts as ERROR, not warning
   - Unused code must be deleted, not suppressed with underscores, comments, or annotations

REPORTING RULES:
- Quote important lines EXACTLY from command output
- Filter out noise (progress bars, timing info, etc.)
- Include file paths and line numbers when present
- Do NOT analyze what the errors mean
- Do NOT suggest fixes or recommendations
- Do NOT provide policy guidance
- Just report what the tools said
- Status is FAIL if Errors > 0, PASS otherwise (warnings alone do not cause FAIL)`;

/**
 * Detect which linter is configured for the project.
 * Returns the lint command to run, or null if no linter found.
 */
function detectLinter(workingDir: string): string | null {
  const checks = [
    { files: ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml", ".eslintrc"], cmd: "npx eslint . 2>&1" },
    { files: ["Cargo.toml"], cmd: "cargo clippy 2>&1 || cargo check 2>&1" },
    { files: ["pyproject.toml", "setup.py"], cmd: "ruff check . 2>&1 || pylint . 2>&1" },
    { files: ["go.mod"], cmd: "golangci-lint run 2>&1 || go vet ./... 2>&1" },
  ];

  for (const { files, cmd } of checks) {
    for (const file of files) {
      if (fs.existsSync(path.join(workingDir, file))) {
        return cmd;
      }
    }
  }
  return null;
}

export async function runCheckAgent(workingDir: string): Promise<string> {
  // Step 1: Run linter if configured
  let lintOutput = "";
  const lintCmd = detectLinter(workingDir);
  if (lintCmd) {
    const lint = runCommand(lintCmd, workingDir);
    lintOutput = `LINTER OUTPUT (exit code ${lint.exitCode}):\n${lint.output}\n`;
  }

  // Step 2: Run make check
  const check = runCommand("make check 2>&1", workingDir);
  const checkOutput = `MAKE CHECK OUTPUT (exit code ${check.exitCode}):\n${check.output}`;

  // Step 3: Single API call to summarize
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: getModelId("sonnet"),
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Summarize these check results:\n\n${lintOutput}${checkOutput}`,
      },
    ],
  });

  const output = extractTextFromResponse(response);

  logToHomeAssistant({
    agent: "check",
    level: "info",
    problem: workingDir,
    answer: output,
  });

  return output;
}
