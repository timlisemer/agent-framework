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
import * as Paths from "./paths.js";
import * as History from "./session-history.js";
import * as RuntimeHome from "./runtime-home.js";
import type { AdapterSpec } from "../../src/adapter/types.js";
import { extractJsonContextMessage } from "../../src/adapter/context-message.js";
import { summarizeToolInputForLlm } from "../../src/utils/tool-input-summary.js";

export const claudeSpec: AdapterSpec = {
  name: "claude",
  encoder: claudeEncoder,
  runtimeHome: {
    dotRoot: RuntimeHome.dotRoot,
    authFiles: RuntimeHome.CLAUDE_AUTH_FILES,
    durableManagedEntries: RuntimeHome.CLAUDE_DURABLE_MANAGED_ENTRIES,
    applyRuntimeEnv: RuntimeHome.applyRuntimeEnv,
    resolveNativeRoot: RuntimeHome.resolveNativeRoot,
    removeMcpServerConfig: RuntimeHome.removeMcpServerConfig,
    sanitizeLocalSettings: RuntimeHome.sanitizeLocalSettings,
    removeHooksConfig: RuntimeHome.removeHooksConfig,
    removeStopHookFromSettings: RuntimeHome.removeStopHookFromSettings,
  },
  recognizeMcp: MCP.recognizeMcp,
  mcpWireName:  MCP.mcpWireName,
  recognizeMcpServerTool: MCP.recognizeMcpServerTool,
  canonicalizeToolCall: TC.canonicalizeToolCall,
  summarizeToolCallForLlm: ({ canonicalToolName, canonicalToolInput }) =>
    summarizeToolInputForLlm(canonicalToolName, canonicalToolInput),
  isFabricatedDenyReason: () => false,
  rawToolNameIsAppealAlias: () => false,
  recognizeWorkflowInvocation: WI.recognizeWorkflowInvocation,
  isWorkflowInvocationOnly: WI.isWorkflowInvocationOnly,
  renderWorkflowInvocation:    WI.renderWorkflowInvocation,
  workflowInstructionText:     WI.workflowInstructionText,
  parseTranscript: PT.parseTranscript,
  canInferUnflushedParallelToolUse: PT.canInferUnflushedParallelToolUse,
  transcriptMessageGroupKey: PT.transcriptMessageGroupKey,
  isInterruptionMessage: IR.isInterruptionMessage,
  extractContextMessage: (_event, stdout) => extractJsonContextMessage(stdout),
  resolveHostContext:     HC.resolveHostContext,
  isEditIntentExemptPath: HC.isEditIntentExemptPath,
  projectTranscriptsDir:  Paths.projectTranscriptsDir,
  projectTranscriptFile:  Paths.projectTranscriptFile,
  listProjectTranscripts: Paths.listProjectTranscripts,
  sessionHistory: History,
  findNativePlanFile:     PLS.findNativePlanFile,
  isPlanExit:             PLS.isPlanExit,
  extractStopProposedPlan: PLS.extractStopProposedPlan,
  detectPlanMode:         PM.detectPlanMode,
  materializeScenarioEntry: SM.materializeScenarioEntry,
  renderCheckMcpHint:               PS.renderCheckMcpHint,
  renderWorkflowAuthorizationHint:  PS.renderWorkflowAuthorizationHint,
  instructionLabel: PS.instructionLabel,
};
