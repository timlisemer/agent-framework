import { checkAppeal } from "../agents/hooks/tool-appeal.js";
import { type CheckResult } from "../types.js";
import { readTranscriptExact, formatTranscriptResult } from "./transcript.js";
import { APPEAL_COUNTS } from "./transcript-presets.js";

// Re-export CheckResult for backwards compatibility
export type { CheckResult } from "../types.js";

export interface CheckWithAppealOptions {
  /** Working directory for telemetry */
  workingDir: string;
  /** Hook name for telemetry */
  hookName: string;
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
  options: CheckWithAppealOptions
): Promise<CheckResult> {
  const result = await check();

  if (result.approved) {
    return result;
  }

  // Appeal the denial
  const transcriptResult = await readTranscriptExact(transcriptPath, APPEAL_COUNTS);
  const transcript = formatTranscriptResult(transcriptResult);

  // Use custom appeal context if provided, otherwise default to tool description
  const appealDescription = options.appealContext ?? `${toolName} with ${JSON.stringify(toolInput).slice(0, 200)}`;

  const appeal = await checkAppeal(
    toolName,
    appealDescription,
    transcript,
    result.reason || "No reason provided",
    options.workingDir,
    options.hookName
  );

  if (appeal.approved) {
    options?.onAppealSuccess?.();
    return { approved: true };
  }

  return { approved: false, reason: appeal.reason ?? result.reason };
}
