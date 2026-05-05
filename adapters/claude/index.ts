import { claudeEncoder } from "./encoder.js";
import * as MCP from "./recognize-mcp.js";
import * as TC  from "./canonicalize-tool-call.js";
import * as WI  from "./workflow-invocation.js";
import * as PT  from "./parse-transcript.js";
import * as IR  from "./interruption.js";
import * as HC  from "./host-context.js";
import * as SM  from "./scenario-materializer.js";
import * as PS  from "./prompt-strings.js";
import type { AdapterSpec } from "../../src/adapter/types.js";

export const claudeSpec: AdapterSpec = {
  name: "claude",
  encoder: claudeEncoder,
  recognizeMcp: MCP.recognizeMcp,
  mcpWireName:  MCP.mcpWireName,
  canonicalizeToolCall: TC.canonicalizeToolCall,
  recognizeWorkflowInvocation: WI.recognizeWorkflowInvocation,
  renderWorkflowInvocation:    WI.renderWorkflowInvocation,
  parseTranscript: PT.parseTranscript,
  isInterruptionMessage: IR.isInterruptionMessage,
  resolveHostContext:     HC.resolveHostContext,
  isEditIntentExemptPath: HC.isEditIntentExemptPath,
  materializeScenarioEntry: SM.materializeScenarioEntry,
  renderCheckMcpHint:               PS.renderCheckMcpHint,
  renderWorkflowAuthorizationHint:  PS.renderWorkflowAuthorizationHint,
  instructionLabel: PS.instructionLabel,
};
