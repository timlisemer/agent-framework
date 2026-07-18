import { allowedEditTargetCounts } from "../../utils/drift-detector.js";
import { createAgentFrameworkScenarioRuntime } from "../../effects/scenario-runtime-factory.js";
import {
  sessionWorkflowStateFromJson,
  type SessionWorkflowState,
  updateAgentFrameworkWorkflow,
} from "../../effects/session-workflow.js";
import { canonicalToolHistory } from "../../effects/tool-history.js";

export async function resetCanonicalDriftWindow(runId: string): Promise<void> {
  await updateCanonicalWorkflow(runId, (state) => ({
    ...state,
    driftState: {},
    driftReductionCredits: {},
    lastUserMessageTimestamp: Date.now(),
  }));
}

export async function reduceCanonicalDriftWindow(
  runId: string,
  reduction: number,
): Promise<void> {
  const runtime = createAgentFrameworkScenarioRuntime();
  const snapshot = await runtime.snapshot(runId);
  const since = sessionWorkflowStateFromJson(snapshot.stateSlices["session.workflow"]?.value)
    .lastUserMessageTimestamp ?? 0;
  const counts = allowedEditTargetCounts(
    canonicalToolHistory(snapshot).filter((entry) => entry.ts >= since),
  );
  await updateAgentFrameworkWorkflow(runtime, runId, "mcp.validationFeedback", (state) => ({
    ...state,
    driftReductionCredits: Object.fromEntries(Object.entries(counts).map(([target, count]) => [
      target,
      Math.min(count, (state.driftReductionCredits?.[target] ?? 0) + reduction),
    ])),
  }));
}

async function updateCanonicalWorkflow(
  runId: string,
  update: (state: SessionWorkflowState) => SessionWorkflowState,
): Promise<void> {
  const runtime = createAgentFrameworkScenarioRuntime();
  await updateAgentFrameworkWorkflow(runtime, runId, "mcp.validationFeedback", update);
}
