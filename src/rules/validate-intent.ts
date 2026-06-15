import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { runAgent } from "../utils/agent-runner.js";
import { activeSpec } from "../adapter/spec.js";
import { getUncommittedChanges } from "../utils/git-utils.js";
import { readTranscriptExact, formatTranscriptResult } from "../utils/transcript.js";
import { VALIDATE_INTENT_COUNTS } from "../utils/transcript-presets.js";
import { readCurrentPlanContent } from "../utils/plan-source.js";
import { VALIDATE_INTENT_AGENT } from "../utils/agent-configs.js";

export const validateIntentRule: PreToolRule = {
  name: "validate-intent",
  displayName: "Validate Intent",
  priority: 50,
  appealable: false,
  usesLlm: true,
  events: ["PreToolUse"],
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (activeSpec().recognizeMcp(ctx.rawToolName ?? ctx.toolName) !== "validate_intent") return null;

    const tx = await readTranscriptExact(ctx.transcriptPath, VALIDATE_INTENT_COUNTS).catch(() => null);
    if (!tx || tx.user.length === 0) return null;

    const { status, diff } = getUncommittedChanges(ctx.projectDir);
    if (!diff && !status) return null;

    const plan = (await readCurrentPlanContent({
      transcriptPath: ctx.transcriptPath,
      sessionDir: ctx.sessionDir,
    }).catch(() => null)) || "(no plan file for this session)";

    const result = await runAgent(
      { ...VALIDATE_INTENT_AGENT, workingDir: ctx.projectDir },
      {
        prompt: "Evaluate if the AI followed user intentions:",
        context:
          `CONVERSATION:\n${formatTranscriptResult(tx)}\n\n---\n\n` +
          `UNCOMMITTED CHANGES:\n${diff || "(no diff)"}\n\n---\n\n` +
          `PLAN FILE:\n${plan}`,
      }
    );

    return { fastDeny: result.output };
  },
};
