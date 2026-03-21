/**
 * Gate Agent - Unified PreToolUse Gate Validator
 *
 * This agent is the final gate for PreToolUse tool calls. It consolidates
 * the checks previously done by error-acknowledge and response-align into
 * a single context-aware evaluation.
 *
 * ## FLOW
 *
 * 1. Build dynamic context from user intent, misalignments, and gate reasoning
 * 2. Run GATE_AGENT via runAgentWithRetryAndTelemetry
 * 3. Parse APPROVE/DENY response
 * 4. Return approved status and optional denial reason
 *
 * ## CONTEXT INPUTS
 *
 * - userIntent: What the user wants (from intent-capture or transcript)
 * - misalignments: Known issues flagged in prior checks
 * - gateReasoning: Most recent gate reasoning for continuity
 *
 * @module gate
 */

import { EXECUTION_TYPES } from "../../types.js";
import { runAgentWithRetryAndTelemetry } from "../../utils/agent-runner.js";
import { GATE_AGENT } from "../../utils/agent-configs.js";
import { startsWithAny } from "../../utils/retry.js";
import { logFastPathApproval } from "../../utils/logger.js";

// Patterns indicating AI is asking a question/clarification that should wait for user response
const PREAMBLE_CONCERN_PATTERNS = [
  /I need to clarify/i,
  /let me clarify/i,
  /to clarify/i,
  /before I proceed/i,
  /before we continue/i,
  /just to confirm/i,
  /to make sure/i,
  /I'm not sure if/i,
  /I'm uncertain/i,
];

/**
 * Check if the AI acknowledgment contains potential preamble violations.
 * Returns true if the LLM should be alerted to check this.
 */
function hasPreambleConcern(ackText: string): boolean {
  if (!ackText) return false;

  for (const pattern of PREAMBLE_CONCERN_PATTERNS) {
    if (pattern.test(ackText)) {
      return true;
    }
  }

  const sentences = ackText.split(/[.!]\s*/);
  for (const sentence of sentences) {
    if (sentence.trim().endsWith("?")) {
      if (!/^(?:I wonder|wondering|why (?:does|is|would) (?:this|that))/i.test(sentence)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Run the gate check for a tool call against captured user intent and context.
 *
 * @param toolName - Name of the tool being evaluated
 * @param toolInput - Input parameters for the tool
 * @param context - Structured context: user intent, flagged misalignments, gate reasoning
 * @param projectDir - Working directory of the project
 * @param hookName - Hook that triggered this check (for telemetry)
 * @returns Approval result with optional denial reason
 *
 * @example
 * ```typescript
 * const result = await checkGate(
 *   "Edit",
 *   { file_path: "src/auth.ts", old_string: "...", new_string: "..." },
 *   { userIntent: "Fix the auth bug", misalignments: "", gateReasoning: "" },
 *   "/path/to/project",
 *   "PreToolUse"
 * );
 * if (!result.approved) {
 *   // Block: gate denied the tool call
 * }
 * ```
 */
export async function checkGate(
  toolName: string,
  toolInput: unknown,
  context: { userIntent: string; misalignments: string; gateReasoning: string },
  projectDir: string,
  hookName: string
): Promise<{ approved: boolean; reason?: string }> {
  let contextSection = `USER INTENT:\n${context.userIntent || "(not yet captured)"}\n`;

  if (context.misalignments) {
    contextSection += `\nFLAGGED MISALIGNMENTS:\n${context.misalignments}\n`;
  }

  if (context.gateReasoning) {
    contextSection += `\nRECENT GATE REASONING:\n${context.gateReasoning}\n`;
  }

  // Check for preamble concern in gate reasoning and surface it
  if (context.gateReasoning && hasPreambleConcern(context.gateReasoning)) {
    contextSection += `\nPREAMBLE CONCERN DETECTED: The recent reasoning contains clarification patterns. Check if the AI should have waited for user response.\n`;
  }

  let result;
  try {
    result = await runAgentWithRetryAndTelemetry(
      { ...GATE_AGENT, workingDir: projectDir },
      {
        prompt: "Evaluate this tool call against user intent.",
        context: `${contextSection}\nTOOL TO EVALUATE:\nTool: ${toolName}\nInput: ${JSON.stringify(toolInput)}`,
      },
      {
        formatValidator: (text) => startsWithAny(text, ["APPROVE", "DENY:"]),
        formatReminder: "Reply with EXACTLY: APPROVE or DENY: <reason>",
      },
      {
        agent: "gate",
        hookName,
        toolName,
        workingDir: projectDir,
        executionType: EXECUTION_TYPES.LLM,
      }
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logFastPathApproval("gate", hookName, toolName, projectDir, `Gate error (fail open): ${errorMsg}`);
    return { approved: true };
  }

  if (result.output.startsWith("APPROVE")) {
    return { approved: true };
  }

  const reason = result.output.startsWith("DENY: ")
    ? result.output.replace("DENY: ", "")
    : `Gate check failed: ${result.output}`;

  return { approved: false, reason };
}
