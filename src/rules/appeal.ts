import { appealHelper } from "../agents/hooks/tool-appeal.js";
import { buildAppealUserState } from "../agents/hooks/tool-appeal-user-state.js";
import type { JsonValue } from "../scenario/protocol/common.js";
import { digestScenarioValue } from "../scenario/protocol/digest.js";
import { formatTranscriptResult, readTranscriptExact } from "../utils/transcript.js";
import { APPEAL_COUNTS } from "../utils/transcript-presets.js";
import type { RuleContext } from "./types.js";
import {
  appealToolIdentityFromRuleContext,
  summarizeRuleToolCall,
} from "./tool-call-context.js";

export type RuleAppealStage = {
  eventType: "rule.appeal.started" | "rule.appeal.completed";
  ruleId: string;
  payload: Record<string, JsonValue>;
};

export type RunAppealWithTraceInput = {
  context: RuleContext;
  hookName: string;
  ruleId: string;
  reason: string;
  blockedBy: string;
  additionalContext?: string;
  onOverturned?(): Promise<void>;
  onStage?(stage: RuleAppealStage): void;
};

/** Canonical orchestration for every traced rule appeal. */
export async function runAppealWithTrace(
  input: RunAppealWithTraceInput,
): Promise<{ overturned: boolean; gateNote?: string }> {
  const transcriptResult = await readTranscriptExact(input.context.transcriptPath, {
    ...APPEAL_COUNTS,
    includeSlashCommandContext: true,
  });
  const resolvedGuidance =
    input.additionalContext ?? `${input.blockedBy} blocked: ${input.reason}`;
  input.onStage?.({
    eventType: "rule.appeal.started",
    ruleId: input.ruleId,
    payload: {
      ruleId: input.ruleId,
      reason: input.reason,
      ...(input.additionalContext === undefined
        ? {}
        : {
            guidanceSource: "rule",
            resolvedGuidanceDigest: digestScenarioValue(resolvedGuidance),
          }),
    },
  });
  const appeal = await appealHelper(
    input.context.toolName,
    summarizeRuleToolCall(input.context),
    formatTranscriptResult(transcriptResult),
    input.reason,
    input.context.projectDir,
    input.hookName,
    buildAppealUserState(input.context.state),
    resolvedGuidance,
    transcriptResult.slashCommandContext,
    appealToolIdentityFromRuleContext(input.context),
    input.context.signal,
  );
  if (appeal.overturned) await input.onOverturned?.();
  input.onStage?.({
    eventType: "rule.appeal.completed",
    ruleId: input.ruleId,
    payload: {
      ruleId: input.ruleId,
      overturned: appeal.overturned,
      gateNote: appeal.gateNote ?? null,
    },
  });
  return appeal;
}
