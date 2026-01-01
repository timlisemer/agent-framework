/**
 * Validate Intent Agent - User Intention Alignment Check
 *
 * This agent evaluates whether the AI correctly followed user intentions
 * by analyzing the conversation, code changes, and plan (if exists).
 *
 * ## FLOW
 *
 * 1. Gather conversation transcript (user + assistant messages)
 * 2. Get uncommitted code changes (git diff)
 * 3. Find and read plan file (if exists for this session)
 * 4. Run sonnet agent to evaluate alignment
 * 5. Return verdict (ALIGNED or DRIFTED)
 *
 * ## INPUT DATA
 *
 * - Transcript: USER:/ASSISTANT: conversation (no tool results)
 * - Git diff: All uncommitted changes
 * - Plan: Content of ~/.claude/plans/{slug}.md if exists
 *
 * ## PLAN FILE RESOLUTION
 *
 * 1. Extract session ID from transcript path
 * 2. Read session JSONL to find `slug` field
 * 3. Load plan from ~/.claude/plans/{slug}.md
 *
 * @module validate-intent
 */

import { runAgent } from "../../utils/agent-runner.js";
import { VALIDATE_INTENT_AGENT } from "../../utils/agent-configs.js";
import { getUncommittedChanges } from "../../utils/git-utils.js";
import { logToHomeAssistant } from "../../utils/logger.js";
import {
  readTranscriptExact,
  formatTranscriptResult,
} from "../../utils/transcript.js";
import { VALIDATE_INTENT_COUNTS } from "../../utils/transcript-presets.js";
import { readPlanContent } from "../../utils/session-utils.js";

/**
 * Run the validate-intent agent to check user intention alignment.
 *
 * @param workingDir - The project directory to evaluate
 * @param transcriptPath - Path to the conversation transcript
 * @returns Structured verdict with ALIGNED or DRIFTED
 *
 * @example
 * ```typescript
 * const result = await runValidateIntentAgent('/path/to/project', '/path/to/transcript.jsonl');
 * if (result.includes('ALIGNED')) {
 *   // AI followed user intentions
 * } else {
 *   // Review the drift reason
 * }
 * ```
 */
export async function runValidateIntentAgent(
  workingDir: string,
  transcriptPath: string
): Promise<string> {
  // Step 1: Gather conversation transcript
  let conversationContext = "(no transcript available)";
  try {
    const transcriptResult = await readTranscriptExact(
      transcriptPath,
      VALIDATE_INTENT_COUNTS
    );
    conversationContext = formatTranscriptResult(transcriptResult);

    // Skip if no meaningful conversation
    if (transcriptResult.user.length === 0) {
      return `## Analysis
- Request: No user messages found
- Plan: N/A
- Changes: N/A

## Verdict
ALIGNED: No user requests to evaluate`;
    }
  } catch {
    // Continue with empty transcript - we can still evaluate changes
    conversationContext = "(transcript read error)";
  }

  // Step 2: Get uncommitted code changes
  const { status, diff } = getUncommittedChanges(workingDir);

  // Skip if no changes
  if (!diff && !status) {
    return `## Analysis
- Request: User request identified
- Plan: N/A
- Changes: No uncommitted changes

## Verdict
ALIGNED: No code changes to evaluate`;
  }

  // Step 3: Find and read plan file
  let planContent = "(no plan file for this session)";
  try {
    const plan = readPlanContent(transcriptPath);
    if (plan) {
      planContent = plan;
    }
  } catch {
    // No plan is fine
  }

  // Step 4: Run the validation agent
  const result = await runAgent(
    { ...VALIDATE_INTENT_AGENT, workingDir },
    {
      prompt: "Evaluate if the AI followed user intentions:",
      context: `CONVERSATION (user requests and AI responses):
${conversationContext}

---

UNCOMMITTED CHANGES (git diff):
${diff || "(no diff)"}

---

PLAN FILE:
${planContent}`,
    }
  );

  // Log the decision
  logToHomeAssistant({
    agent: "validate-intent",
    level: "decision",
    problem: workingDir,
    answer: result.slice(0, 500),
  });

  return result;
}
