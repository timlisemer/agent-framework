import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { runAgent } from "../utils/agent-runner.js";
import { getUncommittedChangesCancellable } from "../utils/git-utils.js";
import {
  readTranscriptExact,
  formatTranscriptResult,
} from "../utils/transcript.js";
import { VALIDATE_INTENT_COUNTS } from "../utils/transcript-presets.js";
import { readCurrentPlanContent } from "../utils/plan-source.js";
import { VALIDATE_INTENT_AGENT } from "../utils/agent-configs.js";
import { recognizeMcpToolName } from "../adapter/mcp-wire.js";
import { adapterSpecFromRuleContext } from "./tool-call-context.js";
import { VALIDATE_INTENT_RULE_POLICY } from "./policies.js";

export const validateIntentRule: PreToolRule = {
  name: "validate-intent",
  displayName: "Validate Intent",
  priority: 50,
  appealable: false,
  usesLlm: true,
  evaluationAgent: VALIDATE_INTENT_AGENT,
  version: "1",
  configuration: VALIDATE_INTENT_RULE_POLICY,
  events: ["PreToolUse"],
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (
      recognizeMcpToolName(
        ctx.rawToolName ?? ctx.toolName,
        adapterSpecFromRuleContext(ctx),
      ) !== "validate_intent"
    )
      return null;

    const tx = await readTranscriptExact(
      ctx.transcriptPath,
      VALIDATE_INTENT_COUNTS,
    ).catch(() => null);
    if (!tx || tx.user.length === 0) return null;

    const { status, diff } = await getUncommittedChangesCancellable(
      ctx.projectDir,
      { signal: ctx.signal },
    );
    if (!diff && !status) return null;

    const plan =
      (await readCurrentPlanContent({
      transcriptPath: ctx.transcriptPath,
      sessionDir: ctx.sessionDir,
    }).catch(() => null)) || "(no plan file for this session)";

    const result = await runAgent(
      { ...validateIntentRule.evaluationAgent!, workingDir: ctx.projectDir },
      {
        prompt: "Evaluate if the AI followed user intentions:",
        context:
          `CONVERSATION:\n${formatTranscriptResult(tx)}\n\n---\n\n` +
          `UNCOMMITTED CHANGES:\n${diff || "(no diff)"}\n\n---\n\n` +
          `PLAN FILE:\n${plan}`,
      },
      { signal: ctx.signal },
    );

    return { fastDeny: result.output };
  },
};
