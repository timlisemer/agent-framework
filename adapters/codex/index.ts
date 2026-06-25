import { codexEncoder } from "./encoder.js";
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
import type {
  AdapterSpec,
  AdapterToolCallContext,
} from "../../src/adapter/types.js";
import { extractJsonContextMessage } from "../../src/adapter/context-message.js";
import { summarizeToolInputForLlm } from "../../src/utils/tool-input-summary.js";
import { extractApplyPatchPaths } from "./apply-patch-parser.js";

function isPatchEditAlias(input: AdapterToolCallContext): boolean {
  if (input.rawToolName !== "apply_patch") return false;
  if (input.canonicalToolName !== "Edit") return false;
  const canonical = input.canonicalToolInput as { file_paths?: unknown } | null | undefined;
  return Array.isArray(canonical?.file_paths);
}

function canonicalFilePaths(input: AdapterToolCallContext): string[] {
  const canonical = input.canonicalToolInput as { file_paths?: unknown } | null | undefined;
  return Array.isArray(canonical?.file_paths)
    ? canonical.file_paths.filter((p): p is string => typeof p === "string")
    : [];
}

export const codexSpec: AdapterSpec = {
  name: "codex",
  encoder: codexEncoder,
  runtimeHome: {
    dotRoot: RuntimeHome.dotRoot,
    authFiles: RuntimeHome.CODEX_AUTH_FILES,
    durableManagedEntries: RuntimeHome.CODEX_DURABLE_MANAGED_ENTRIES,
    applyRuntimeEnv: RuntimeHome.applyRuntimeEnv,
    resolveNativeRoot: RuntimeHome.resolveNativeRoot,
    writeMinimalConfig: RuntimeHome.writeMinimalConfig,
    rewriteConfig: RuntimeHome.rewriteConfig,
    sandboxModeForToolPolicy: RuntimeHome.sandboxModeForToolPolicy,
    removeMcpServerConfig: RuntimeHome.removeMcpServerConfig,
    removeHooksConfig: RuntimeHome.removeHooksConfig,
    buildHookTrustBlock: RuntimeHome.buildHookTrustBlock,
  },
  recognizeMcp: MCP.recognizeMcp,
  mcpWireName:  MCP.mcpWireName,
  recognizeMcpServerTool: MCP.recognizeMcpServerTool,
  canonicalizeToolCall: TC.canonicalizeToolCall,
  summarizeToolCallForLlm: (input) => {
    if (isPatchEditAlias(input)) {
      const rawPaths = extractApplyPatchPaths(input.rawToolInput);
      const paths = rawPaths.length > 0 ? rawPaths : canonicalFilePaths(input);
      return `ApplyPatch(file_paths=${JSON.stringify(paths)})`;
    }
    return summarizeToolInputForLlm(input.canonicalToolName, input.canonicalToolInput);
  },
  isFabricatedDenyReason: (reason, input) =>
    isPatchEditAlias(input) &&
    /old_string[^.]*new_string[^.]*(?:non-string|missing|malformed|invalid)/i.test(reason),
  rawToolNameIsAppealAlias: (input) => isPatchEditAlias(input),
  recognizeWorkflowInvocation: WI.recognizeWorkflowInvocation,
  isWorkflowInvocationOnly: WI.isWorkflowInvocationOnly,
  renderWorkflowInvocation:    WI.renderWorkflowInvocation,
  workflowInstructionText:     WI.workflowInstructionText,
  parseTranscript: PT.parseTranscript,
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
