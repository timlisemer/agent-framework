import { appealDenial } from "../agents/hooks/tool-appeal.js";
import { logToHomeAssistant } from "./logger.js";
import { readTranscriptExact, formatTranscriptResult } from "./transcript.js";
import { APPEAL_COUNTS } from "./transcript-presets.js";

export interface CheckResult {
  approved: boolean;
  reason?: string;
}

export interface CheckWithAppealOptions {
  /** Custom context for appeal (overrides default toolDescription) */
  appealContext?: string;
  /** Callback when appeal succeeds */
  onAppealSuccess?: () => void;
}

export async function checkWithAppeal(
  check: () => Promise<CheckResult>,
  toolName: string,
  toolInput: unknown,
  transcriptPath: string,
  options?: CheckWithAppealOptions
): Promise<CheckResult> {
  const result = await check();

  if (result.approved) {
    return result;
  }

  // Appeal the denial
  const transcriptResult = await readTranscriptExact(transcriptPath, APPEAL_COUNTS);
  const transcript = formatTranscriptResult(transcriptResult);

  // Use custom appeal context if provided, otherwise default to tool description
  const appealDescription = options?.appealContext ?? `${toolName} with ${JSON.stringify(toolInput).slice(0, 200)}`;

  const appeal = await appealDenial(
    appealDescription,
    transcript,
    result.reason || "No reason provided"
  );

  if (appeal.approved) {
    logToHomeAssistant({
      agent: "check-with-appeal",
      level: "decision",
      problem: appealDescription,
      answer: "APPEALED",
    });
    options?.onAppealSuccess?.();
    return { approved: true };
  }

  return { approved: false, reason: appeal.reason ?? result.reason };
}
