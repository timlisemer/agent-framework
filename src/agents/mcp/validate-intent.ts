/**
 * Validate Intent Agent - User Intention Alignment Check
 *
 * This agent evaluates whether the AI correctly followed user intentions
 * by analyzing the conversation, code changes, and plan (if exists).
 *
 * @module validate-intent
 */

import { EXECUTION_TYPES } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { VALIDATE_INTENT_AGENT } from "../../utils/agent-configs.js";
import { getUncommittedChanges } from "../../utils/git-utils.js";
import { logApprove, logDeny } from "../../utils/logger.js";
import {
  readTranscriptExact,
  formatTranscriptResult,
} from "../../utils/transcript.js";
import { VALIDATE_INTENT_COUNTS } from "../../utils/transcript-presets.js";
import { readPlanContent } from "../../utils/session-utils.js";

const HOOK_NAME = "mcp__agent-framework__validate_intent";

/**
 * Run the validate-intent agent to check user intention alignment.
 *
 * @param workingDir - The project directory to evaluate
 * @param transcriptPath - Path to the conversation transcript
 * @returns Structured verdict with ALIGNED or DRIFTED
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

    if (transcriptResult.user.length === 0) {
      return `## Analysis
- Request: No user messages found
- Plan: N/A
- Changes: N/A

## Verdict
ALIGNED: No user requests to evaluate`;
    }
  } catch {
    conversationContext = "(transcript read error)";
  }

  // Step 2: Get uncommitted code changes
  const { status, diff } = getUncommittedChanges(workingDir);

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
    const plan = await readPlanContent(transcriptPath);
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

  const isAligned = result.output.includes("ALIGNED");

  if (isAligned) {
    logApprove(
      result,
      "validate-intent",
      HOOK_NAME,
      HOOK_NAME,
      workingDir,
      EXECUTION_TYPES.LLM,
      result.output.slice(0, 500)
    );
  } else {
    logDeny(
      result,
      "validate-intent",
      HOOK_NAME,
      HOOK_NAME,
      workingDir,
      EXECUTION_TYPES.LLM,
      result.output.slice(0, 500)
    );
  }

  return result.output;
}
