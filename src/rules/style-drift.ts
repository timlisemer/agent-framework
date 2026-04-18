import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { isTrustedPath, isSensitivePath } from "./utils.js";
import { checkStyleDrift } from "../agents/hooks/style-drift.js";
import { readTranscriptExact, formatTranscriptResult } from "../utils/transcript.js";
import { STYLE_DRIFT_COUNTS } from "../utils/transcript-presets.js";
import { appealHelper } from "../agents/hooks/tool-appeal.js";

export const styleDriftRule: PreToolRule = {
  name: "style-drift",
  displayName: "Style Drift",
  priority: 65,
  appealable: true,
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
      const appeal = await appealHelper(
        ctx.toolName,
        `Edit to ${filePath}`,
        userMessages,
        styleDriftResult.reason || "Style drift detected",
        ctx.projectDir,
        "PreToolUse",
        `style-drift blocked: ${styleDriftResult.reason}`
      );

      if (!appeal.overturned) {
        return { fastDeny: `Style drift detected: ${styleDriftResult.reason}` };
      }
      // Appeal overturned -- fall through
    }

    return { fastAllow: "Style drift check passed" };
  },
};
