import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import {
  evaluateBashPolicy,
  getHardBlacklistHighlights,
} from "../utils/command-patterns.js";
import { activeSpec } from "../adapter/spec.js";
import {
  decideRequiredWorkflowToolSequence,
  requiredMcpToolSequence,
  requireToolSequenceNext,
} from "../utils/prediction-types.js";

export const blacklistRule: PreToolRule = {
  name: "blacklist",
  displayName: "Blacklist",
  priority: 34,
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    const prediction = ctx.state.currentPrediction;
    if (
      prediction?.explicitlyRequiredTools?.length &&
      decideRequiredWorkflowToolSequence(prediction, [{
        toolName: ctx.toolName,
        toolInput: ctx.toolInput,
      }]).decision === "deny"
    ) {
      return null;
    }

    const highlights = getHardBlacklistHighlights(ctx.toolName, ctx.toolInput, ctx.projectDir);
    if (highlights.length === 0) return null;

    const reason = highlights
      .map((h) => h.replace(/^\[(?:BLACKLIST|CHECK-ROUTED): [^\]]+\]\s*/, ""))
      .join(". ");
    return { fastDeny: reason };
  },

  async onDenialConfirmed(ctx: RuleContext, _reason: string): Promise<void> {
    if (ctx.toolName !== "Bash") return;
    const command = (ctx.toolInput as { command?: string }).command ?? "";
    const policy = evaluateBashPolicy(command, ctx.projectDir);
    if (policy.terminal.ownerTopic !== "check-routed") return;

    const spec = activeSpec();
    const required = requiredMcpToolSequence(
      "check",
      `The denied ${policy.terminal.ownerName} command must be run through ${spec.renderCheckMcpHint()}`,
    );
    const userMessage = ctx.latestUserMessage ??
      ctx.state.currentPrediction?.userMessageFull ??
      ctx.state.currentPrediction?.userMessageSnippet ??
      "Run the supported repository check.";
    await ctx.stateManager.update((s) => ({
      ...s,
      currentPrediction: requireToolSequenceNext(
        s.currentPrediction,
        required,
        {
          intent: "Run the repository checks through the agent-framework check MCP.",
          userMessage,
        },
      ),
    }));
  },
};
