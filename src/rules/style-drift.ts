import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { isTrustedPath, isSensitivePath } from "./utils.js";
import { checkStyleDrift } from "../agents/hooks/style-drift.js";
import { readTranscriptExact, formatTranscriptResult } from "../utils/transcript.js";
import { STYLE_DRIFT_COUNTS } from "../utils/transcript-presets.js";

export const styleDriftRule: PreToolRule = {
  name: "style-drift",
  displayName: "Style Drift",
  priority: 65,
  appealable: false,
  usesLlm: true,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    // Only for Edit tool on trusted non-sensitive paths
    if (ctx.toolName !== "Edit") {
      return null;
    }

    const filePath =
      (ctx.toolInput as { file_path?: string }).file_path ||
      (ctx.toolInput as { path?: string }).path || "";

    if (!filePath || !isTrustedPath(filePath, ctx.projectDir) || isSensitivePath(filePath)) {
      return null;
    }

    const transcriptResult = await readTranscriptExact(
      ctx.transcriptPath,
      STYLE_DRIFT_COUNTS
    );
    const userMessages = formatTranscriptResult(transcriptResult);

    const styleDriftResult = await checkStyleDrift(
      ctx.toolName,
      ctx.toolInput,
      ctx.projectDir,
      userMessages,
      "PreToolUse"
    );

    if (!styleDriftResult.approved) {
      return { fastDeny: `Style drift detected: ${styleDriftResult.reason}` };
    }

    return { fastAllow: "Style drift check passed" };
  },
};
