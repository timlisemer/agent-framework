import { claudeEncoder } from "./encoder.js";
import * as MCP from "./recognize-mcp.js";
import * as TC  from "./canonicalize-tool-call.js";
import * as WI  from "./workflow-invocation.js";
import * as PT  from "./parse-transcript.js";
import * as IR  from "./interruption.js";
import * as HC  from "./host-context.js";
import * as SM  from "./scenario-materializer.js";
import * as PS  from "./prompt-strings.js";
import * as PLS from "./plan-source.js";
import * as PM  from "./plan-mode.js";
import type { AdapterSpec } from "../../src/adapter/types.js";

export const claudeSpec: AdapterSpec = {
  name: "claude",
  encoder: claudeEncoder,
  recognizeMcp: MCP.recognizeMcp,
  mcpWireName:  MCP.mcpWireName,
  canonicalizeToolCall: TC.canonicalizeToolCall,
  recognizeWorkflowInvocation: WI.recognizeWorkflowInvocation,
  isWorkflowInvocationOnly: WI.isWorkflowInvocationOnly,
  renderWorkflowInvocation:    WI.renderWorkflowInvocation,
  parseTranscript: PT.parseTranscript,
  isInterruptionMessage: IR.isInterruptionMessage,
  extractContextMessage: (_event, stdout) => {
    if (!stdout.trim()) return null;
    try {
      const parsed = JSON.parse(stdout) as { systemMessage?: unknown };
      return typeof parsed.systemMessage === "string" ? parsed.systemMessage : null;
    } catch {
      return null;
    }
  },
  resolveHostContext:     HC.resolveHostContext,
  isEditIntentExemptPath: HC.isEditIntentExemptPath,
  findNativePlanFile:     PLS.findNativePlanFile,
  isPlanExit:             PLS.isPlanExit,
  extractStopProposedPlan: PLS.extractStopProposedPlan,
  detectPlanMode:         PM.detectPlanMode,
  materializeScenarioEntry: SM.materializeScenarioEntry,
  renderCheckMcpHint:               PS.renderCheckMcpHint,
  renderWorkflowAuthorizationHint:  PS.renderWorkflowAuthorizationHint,
  instructionLabel: PS.instructionLabel,
};
