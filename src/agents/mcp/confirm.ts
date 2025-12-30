import { execSync } from "child_process";
import { getModelId } from "../../types.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { logToHomeAssistant } from "../../utils/logger.js";
import { extractTextFromResponse } from "../../utils/response-parser.js";
import { runCheckAgent } from "./check.js";

const SYSTEM_PROMPT = `You are a strict code quality gate. You have ONE job: evaluate changes and return a verdict.

The code has already passed linting and type checks. Now evaluate the changes.

STEP 1: Check for unwanted files in the git status.
DECLINE immediately if you see any of these patterns:
- node_modules/ (dependencies should never be committed)
- dist/, build/, out/ (build artifacts)
- .env, .env.local, .env.* (environment files with secrets)
- *.log, *.tmp, *.cache (temporary files)
- .DS_Store, Thumbs.db (OS artifacts)
- __pycache__/, *.pyc (Python cache)
- target/ (Rust/Java build output)
- vendor/ (vendored dependencies)
- coverage/ (test coverage reports)
- .idea/, .vscode/ with settings (IDE configs - unless intentional)

If unwanted files are staged, DECLINE with: "Unwanted files staged: <list>. Check .gitignore."

STEP 2: Evaluate the diff against these criteria:
- No obvious bugs or logic errors
- No security vulnerabilities
- No hardcoded secrets or credentials
- No debug code (console.log, print, dbg!, etc.)
- Changes are coherent and intentional
- Reasonable code style
- No unused code workarounds: If the diff shows unused variables/imports being renamed with underscores (_var), flagged with @ts-ignore/@ts-expect-error, or otherwise suppressed instead of deleted, DECLINE. Unused code must be removed, not hidden.

STEP 3: Documentation check
- Verify documentation is still up to date after the changes
- DECLINE if documentation was left out, and summarize what is missing

OUTPUT FORMAT:
Your response must follow this exact structure:

## Summary
<2-4 sentences describing what the changes do conceptually>

## Verdict
CONFIRMED: <1-2 sentences explaining why the changes are acceptable>
or
DECLINED: <1-2 sentences explaining the specific issue>

RULES:
- You CANNOT ask questions
- You CANNOT request more context
- You CANNOT suggest improvements
- You MUST decide based solely on the diff
- Small, obvious changes bias toward CONFIRMED
- Large, complex changes require higher scrutiny

This is a gate, not a review. Summarize and decide.`;

/**
 * Run a shell command and capture output.
 * Returns { output, exitCode } - never throws.
 */
function runCommand(cmd: string, cwd: string): { output: string; exitCode: number } {
  try {
    const output = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return { output, exitCode: 0 };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; status?: number };
    const output = (error.stdout || "") + (error.stderr || "");
    return { output, exitCode: error.status ?? 1 };
  }
}

export async function runConfirmAgent(workingDir: string): Promise<string> {
  // Step 1: Run check agent first
  const checkResult = await runCheckAgent(workingDir);

  // Step 2: Parse check results for errors
  const errorMatch = checkResult.match(/Errors:\s*(\d+)/i);
  const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 0;
  const statusMatch = checkResult.match(/Status:\s*(PASS|FAIL)/i);
  const checkStatus = statusMatch ? statusMatch[1].toUpperCase() : "UNKNOWN";

  // Step 3: If check failed, decline immediately
  if (checkStatus === "FAIL" || errorCount > 0) {
    const result = `DECLINED: check failed with ${errorCount} error(s)`;
    logToHomeAssistant({
      agent: "confirm",
      level: "decision",
      problem: workingDir,
      answer: result,
    });
    return result;
  }

  // Step 4: Run git commands directly
  const gitStatus = runCommand("git status --porcelain", workingDir);
  const gitDiff = runCommand("git diff HEAD", workingDir);

  // Step 5: Single API call to analyze
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: getModelId("opus"),
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Evaluate these code changes:

GIT STATUS (files changed):
${gitStatus.output || "(no changes)"}

GIT DIFF:
${gitDiff.output || "(no diff)"}`,
      },
    ],
  });

  const output = extractTextFromResponse(response);

  logToHomeAssistant({
    agent: "confirm",
    level: "decision",
    problem: workingDir,
    answer: output,
  });

  return output;
}
