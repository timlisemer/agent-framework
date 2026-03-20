/**
 * Intent Validate Agent - Off-Topic Detection (Summary-Based)
 *
 * Detects when AI has gone off-track using session summary sections
 * instead of raw transcript parsing. Reads User Intent and Flagged
 * Misalignments from the summary document.
 *
 * @module intent-validate
 */

import { EXECUTION_TYPES, type OffTopicCheckResult } from "../../types.js";
import { runAgentWithRetryAndTelemetry } from "../../utils/agent-runner.js";
import { INTENT_VALIDATE_AGENT } from "../../utils/agent-configs.js";
import { logFastPathApproval } from "../../utils/logger.js";
import { startsWithAny } from "../../utils/retry.js";
import { isSubagent } from "../../utils/subagent-detector.js";
import { readTranscriptExact } from "../../utils/transcript.js";
import { readSummarySection } from "../../utils/session-utils.js";
import { getSessionDir, readToolLogTail } from "../../utils/summary-cache.js";
import { getCondensedHistory } from "../../utils/gate-reasoning-cache.js";

/**
 * Check if AI has gone off-topic in its response.
 * Uses session summary sections instead of raw transcript parsing.
 */
export async function checkForOffTopic(
  transcriptPath: string,
  workingDir: string,
  hookName: string
): Promise<OffTopicCheckResult> {
  // Skip for subagents
  if (isSubagent(transcriptPath)) {
    logFastPathApproval("intent-validate", hookName, "StopResponse", workingDir, "Subagent skip");
    return { decision: "OK" };
  }

  // Read summary sections
  const userIntent = await readSummarySection(transcriptPath, "User Intent");
  const misalignments = await readSummarySection(transcriptPath, "Flagged Misalignments");

  // No summary yet - nothing to check against
  if (!userIntent || userIntent.includes("(No intent captured yet)")) {
    logFastPathApproval("intent-validate", hookName, "StopResponse", workingDir, "No summary yet");
    return { decision: "OK" };
  }

  // Read last assistant message
  const transcriptResult = await readTranscriptExact(transcriptPath, {
    counts: { assistant: 1 },
  });
  const lastAssistant = transcriptResult.assistant[transcriptResult.assistant.length - 1];
  if (!lastAssistant) {
    logFastPathApproval("intent-validate", hookName, "StopResponse", workingDir, "No assistant message");
    return { decision: "OK" };
  }

  // Read tool log tail and gate reasoning condensed history
  const sessionDir = getSessionDir(transcriptPath);
  const toolLog = readToolLogTail(sessionDir, 5);
  let condensed = "";
  try {
    condensed = await getCondensedHistory(sessionDir);
  } catch {
    // No gate reasoning yet
  }

  try {
    const result = await runAgentWithRetryAndTelemetry(
      { ...INTENT_VALIDATE_AGENT },
      {
        prompt: "Check if the assistant's response aligns with user intent.",
        context: `USER INTENT:\n${userIntent}\n\nFLAGGED MISALIGNMENTS:\n${misalignments}\n\nRECENT TOOL LOG:\n${toolLog || "(none)"}${condensed ? `\n\nGATE REASONING HISTORY:\n${condensed}` : ""}\n\nASSISTANT'S FINAL RESPONSE:\n${lastAssistant.content}`,
      },
      {
        formatValidator: (text) => startsWithAny(text, ["OK", "INTERVENE:"]),
        formatReminder: "Reply with exactly: OK or INTERVENE: <feedback>",
        maxTokens: 150,
      },
      {
        agent: "intent-validate",
        hookName,
        toolName: "StopResponse",
        workingDir,
        executionType: EXECUTION_TYPES.LLM,
      }
    );

    if (result.output.startsWith("OK")) {
      return { decision: "OK" };
    }

    if (result.output.startsWith("INTERVENE:")) {
      const feedback = result.output.replace("INTERVENE:", "").trim();
      return { decision: "INTERVENE", feedback };
    }

    return { decision: "INTERVENE", feedback: "Malformed response - retry" };
  } catch {
    logFastPathApproval("intent-validate", hookName, "StopResponse", workingDir, "Error path - fail closed");
    return { decision: "INTERVENE", feedback: "Error during validation - retry" };
  }
}
