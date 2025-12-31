import { getModelId } from "../../types.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { getUncommittedChanges } from "../../utils/git-utils.js";
import { logToHomeAssistant } from "../../utils/logger.js";
import { extractTextFromResponse } from "../../utils/response-parser.js";
import { runCheckAgent } from "./check.js";

const SYSTEM_PROMPT = `You are a strict code quality gate. You have ONE job: evaluate changes and return a verdict.

The code has already passed linting and type checks. Now evaluate the changes against these 4 categories:

## CATEGORY 1: Files
Check for unwanted files in the git status. FAIL if you see:
- node_modules/, dist/, build/, out/, target/, vendor/, coverage/
- .env, .env.local, .env.* (environment files with secrets)
- *.log, *.tmp, *.cache, .DS_Store, Thumbs.db
- __pycache__/, *.pyc
- .idea/, .vscode/ with settings (unless intentional)

## CATEGORY 2: Code Quality
Evaluate the diff for:
- No obvious bugs or logic errors
- No debug code (console.log, print, dbg!, etc.)
- Changes are coherent and intentional
- Reasonable code style
- No unused code workarounds (renaming with _var, @ts-ignore, etc. - unused code must be deleted)

## CATEGORY 3: Security
Check for:
- No security vulnerabilities
- No hardcoded secrets or credentials

## CATEGORY 4: Documentation
- Verify documentation is updated if the changes require it
- Note what is missing if applicable

OUTPUT FORMAT:
Your response must follow this exact structure:

## Results
- Files: PASS or FAIL (<brief reason if FAIL>)
- Code Quality: PASS or FAIL (<brief reason if FAIL>)
- Security: PASS or FAIL (<brief reason if FAIL>)
- Documentation: PASS or FAIL (<brief reason if FAIL>)

## Summary
<2-4 sentences describing what the changes do conceptually>

## Verdict
CONFIRMED: <1-2 sentences explaining why the changes are acceptable>
or
DECLINED: <1-2 sentences explaining the specific issue>

RULES:
- You CANNOT ask questions or request more context
- You MUST decide based solely on the diff
- All 4 categories must PASS for CONFIRMED
- Any FAIL means DECLINED
- Small, obvious changes bias toward CONFIRMED

This is a gate, not a review.`;

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
    const result = `## Results
- Files: SKIP
- Code Quality: SKIP
- Security: SKIP
- Documentation: SKIP

## Verdict
DECLINED: check failed with ${errorCount} error(s)`;
    logToHomeAssistant({
      agent: "confirm",
      level: "decision",
      problem: workingDir,
      answer: result,
    });
    return result;
  }

  // Step 4: Get all uncommitted changes
  const { status, diff } = getUncommittedChanges(workingDir);

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
${status || "(no changes)"}

GIT DIFF (all uncommitted changes):
${diff || "(no diff)"}`,
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
