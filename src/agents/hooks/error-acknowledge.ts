/**
 * Error Acknowledge Agent - Issue Acknowledgment Validator
 *
 * This agent validates that the AI has acknowledged real issues before
 * proceeding with tool calls. Prevents AI from ignoring errors.
 *
 * ## FLOW
 *
 * 1. Check if issue was already acknowledged (cached)
 * 2. If cached, return OK immediately
 * 3. Otherwise, run unified agent to evaluate
 * 4. Retry if format is invalid
 * 5. Cache acknowledged issues
 * 6. Return OK or BLOCK with issue details
 *
 * ## REAL vs FALSE POSITIVE
 *
 * Real issues:
 * - TypeScript errors, build failures, test failures
 * - Hook denials with explanations
 * - User directives in ALL CAPS
 *
 * False positives (ignore):
 * - Source code containing "error" or "failed"
 * - Variable names like "errorHandler"
 * - Documentation/prompts being read
 *
 * @module error-acknowledge
 */

import { getModelId } from "../../types.js";
import {
  isErrorAcknowledged,
  markErrorAcknowledged,
} from "../../utils/ack-cache.js";
import { runAgent } from "../../utils/agent-runner.js";
import { ERROR_ACK_AGENT } from "../../utils/agent-configs.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { logToHomeAssistant } from "../../utils/logger.js";
import { parseDecision } from "../../utils/response-parser.js";
import { retryUntilValid, startsWithAny } from "../../utils/retry.js";
import { isSubagent } from "../../utils/subagent-detector.js";

// Pattern to extract issue text from transcript for caching
const ISSUE_EXTRACT_PATTERN =
  /error TS\d+[^\n]*|Error:[^\n]*|failed[^\n]*|FAILED[^\n]*/i;

/**
 * Check if AI has acknowledged issues in the transcript.
 *
 * @param transcript - Recent conversation transcript
 * @param toolName - Name of the tool being called
 * @param toolInput - Input parameters for the tool
 * @param transcriptPath - Optional path to transcript file (used for subagent detection)
 * @returns "OK" if acknowledged, or "BLOCK: ..." with issue details
 *
 * @example
 * ```typescript
 * const result = await checkErrorAcknowledgment(transcript, 'Edit', { file_path: '...' }, '/path/to/transcript');
 * if (result.startsWith('BLOCK:')) {
 *   // AI needs to acknowledge the issue first
 * }
 * ```
 */
export async function checkErrorAcknowledgment(
  transcript: string,
  toolName: string,
  toolInput: unknown,
  transcriptPath?: string
): Promise<string> {
  // Skip error acknowledgment checks for subagents (Task-spawned agents)
  if (transcriptPath && isSubagent(transcriptPath)) {
    logToHomeAssistant({
      agent: "error-acknowledge",
      level: "info",
      problem: toolName,
      answer: "Skipped - subagent session",
    });
    return "OK";
  }
  // Check if the issue in this transcript was already acknowledged
  const issueMatch = transcript.match(ISSUE_EXTRACT_PATTERN);
  if (issueMatch && isErrorAcknowledged(issueMatch[0])) {
    logToHomeAssistant({
      agent: 'error-acknowledge',
      level: 'decision',
      problem: `${toolName} (cached)`,
      answer: 'OK - issue already acknowledged',
    });
    return 'OK';
  }

  const toolDescription = `${toolName} with ${JSON.stringify(toolInput).slice(0, 100)}`;

  // Run acknowledgment check via unified runner
  const initialResponse = await runAgent(
    { ...ERROR_ACK_AGENT },
    {
      prompt: 'Check if the AI has acknowledged issues in this transcript.',
      context: `TRANSCRIPT (recent messages):
${transcript}

CURRENT TOOL CALL:
Tool: ${toolName}
Input: ${JSON.stringify(toolInput)}`,
    }
  );

  // Retry if format is invalid
  const anthropic = getAnthropicClient();
  const decision = await retryUntilValid(
    anthropic,
    getModelId(ERROR_ACK_AGENT.tier),
    initialResponse,
    toolDescription,
    {
      maxRetries: 1, // Only 1 retry for error-acknowledge
      formatValidator: (text) => startsWithAny(text, ['OK', 'BLOCK:']),
      formatReminder: 'Reply with EXACTLY: OK or BLOCK: <message>',
    }
  );

  const parsed = parseDecision(decision, ['OK']);

  if (parsed.approved) {
    // Mark issue as acknowledged so future checks skip it
    if (issueMatch) {
      markErrorAcknowledged(issueMatch[0]);
    }
    logToHomeAssistant({
      agent: 'error-acknowledge',
      level: 'decision',
      problem: toolDescription,
      answer: 'OK',
    });
    return 'OK';
  }

  if (parsed.reason) {
    logToHomeAssistant({
      agent: 'error-acknowledge',
      level: 'decision',
      problem: toolDescription,
      answer: `BLOCKED: ${parsed.reason}`,
    });
    return `BLOCK: ${parsed.reason}`;
  }

  // Default to OK if response is malformed after retries (fail open)
  logToHomeAssistant({
    agent: 'error-acknowledge',
    level: 'info',
    problem: toolDescription,
    answer: `Malformed response after retries: ${decision}`,
  });
  return 'OK';
}
