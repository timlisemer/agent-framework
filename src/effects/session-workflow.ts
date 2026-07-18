import { z } from "zod";
import { createScenarioCommandEnvelope } from "../scenario/protocol/command-envelope.js";
import { canonicalJsonEqual } from "../scenario/protocol/canonical-json.js";
import { toJsonValue } from "../scenario/protocol/common.js";
import { SnapshotRevisionConflictError } from "../scenario/runtime/errors.js";
import type { ScenarioRuntime } from "../scenario/runtime/runtime.js";
import { toolPredictionSchema } from "../utils/prediction-schema.js";
import { agentFrameworkStateChange } from "./state-slices.js";

export const driftTargetStateSchema = z.object({
  level: z.union([z.literal(0), z.literal(1), z.literal(2)]),
}).strict();
export type DriftTargetState = z.infer<typeof driftTargetStateSchema>;

export const sessionWorkflowStateSchema = z.object({
  toolCallCount: z.number().int().nonnegative(),
  currentEditIntent: z.boolean().nullable(),
  previousEditIntent: z.boolean().nullable(),
  editIntentTimestamp: z.number().finite().nonnegative(),
  editIntentOverturnCount: z.number().int().nonnegative(),
  respondFirstChecked: z.boolean(),
  currentPrediction: toolPredictionSchema.nullable(),
  frustrationStreak: z.number().int().nonnegative(),
  currentWindowSize: z.number().int().nonnegative(),
  driftState: z.record(z.string(), driftTargetStateSchema),
  driftReductionCredits: z.record(z.string(), z.number().finite()),
  lastProcessedPlanApprovalToolUseId: z.string().nullable(),
  lastUserMessageTimestamp: z.number().finite().nonnegative(),
  gateReasoningResetAt: z.number().finite().nonnegative(),
}).strict();
export type SessionWorkflowState = z.infer<typeof sessionWorkflowStateSchema>;

type AdditiveCounterKey = "toolCallCount" | "editIntentOverturnCount";
const ADDITIVE_COUNTER_KEYS = new Set<AdditiveCounterKey>([
  "toolCallCount",
  "editIntentOverturnCount",
]);

const partialSessionWorkflowStateSchema = sessionWorkflowStateSchema.partial().strict();

export function sessionWorkflowDefaults(): SessionWorkflowState {
  return {
    toolCallCount: 0,
    currentEditIntent: null,
    previousEditIntent: null,
    editIntentTimestamp: 0,
    editIntentOverturnCount: 0,
    respondFirstChecked: false,
    currentPrediction: null,
    frustrationStreak: 0,
    currentWindowSize: 2,
    driftState: {},
    driftReductionCredits: {},
    lastProcessedPlanApprovalToolUseId: null,
    lastUserMessageTimestamp: 0,
    gateReasoningResetAt: 0,
  };
}

export function sessionWorkflowStateFromJson(value: unknown): SessionWorkflowState {
  if (value === undefined) return sessionWorkflowDefaults();
  return sessionWorkflowStateSchema.parse({
    ...sessionWorkflowDefaults(),
    ...partialSessionWorkflowStateSchema.parse(value),
  });
}

export function mergeSessionWorkflowChanges(
  base: SessionWorkflowState,
  incoming: SessionWorkflowState,
  current: SessionWorkflowState,
): SessionWorkflowState {
  const merged = structuredClone(current) as Record<string, unknown>;
  const baseRecord = base as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(incoming as unknown as Record<string, unknown>)) {
    if (canonicalJsonEqual(toJsonValue(value), toJsonValue(baseRecord[key]))) continue;
    if (ADDITIVE_COUNTER_KEYS.has(key as AdditiveCounterKey)) {
      merged[key] = mergeAdditiveCounter(key as AdditiveCounterKey, base, incoming, current);
      continue;
    }
    if (key === "driftState") {
      merged[key] = mergeChangedMap(base.driftState, incoming.driftState, current.driftState);
      continue;
    }
    if (key === "driftReductionCredits") {
      merged[key] = mergeChangedMap(
        base.driftReductionCredits,
        incoming.driftReductionCredits,
        current.driftReductionCredits,
      );
      continue;
    }
    // Scalar and prediction conflicts are explicit incoming-wins updates.
    merged[key] = value;
  }
  if (
    Number(merged.editIntentOverturnCount) >= 2 &&
    (incoming.editIntentOverturnCount > base.editIntentOverturnCount ||
      current.editIntentOverturnCount > base.editIntentOverturnCount)
  ) {
    merged.currentEditIntent = true;
  }
  return sessionWorkflowStateFromJson(toJsonValue(merged));
}

function mergeAdditiveCounter(
  key: AdditiveCounterKey,
  base: SessionWorkflowState,
  incoming: SessionWorkflowState,
  current: SessionWorkflowState,
): number {
  return Math.max(0, current[key] + incoming[key] - base[key]);
}

function mergeChangedMap<T>(
  base: Record<string, T>,
  incoming: Record<string, T>,
  current: Record<string, T>,
): Record<string, T> {
  const merged = structuredClone(current);
  for (const key of new Set([...Object.keys(base), ...Object.keys(incoming)])) {
    if (canonicalJsonEqual(toJsonValue(base[key]), toJsonValue(incoming[key]))) continue;
    if (key in incoming) merged[key] = incoming[key];
    else delete merged[key];
  }
  return merged;
}

/** Recompute an Agent Framework workflow mutation after revision conflicts. */
export async function updateAgentFrameworkWorkflow(
  runtime: ScenarioRuntime,
  runId: string,
  source: string,
  update: (state: SessionWorkflowState) => SessionWorkflowState | Promise<SessionWorkflowState>,
): Promise<void> {
  const snapshot = await runtime.snapshot(runId);
  await dispatchAgentFrameworkWorkflow({
    runtime,
    runId,
    baseline: {
      state: sessionWorkflowStateFromJson(snapshot.stateSlices["session.workflow"]?.value),
      revision: snapshot.revision,
    },
    prepare: ({ current }) => update(current),
    dispatch: (next, expectedSnapshotRevision) => runtime.dispatch(createScenarioCommandEnvelope({
        runId,
        source: { kind: "gateway" },
        expectedSnapshotRevision,
        payload: {
          type: "stateSliceChanged",
          ...agentFrameworkStateChange({
            key: "session.workflow",
            schemaId: "agent-framework://state/session-workflow",
            source,
            value: next,
          }),
        },
      })),
  });
}

type AgentFrameworkWorkflowBaseline = {
  state: SessionWorkflowState;
  revision: number;
};

/** One optimistic-concurrency loop for every Agent Framework workflow mutation. */
export async function dispatchAgentFrameworkWorkflow<Result>(input: {
  runtime: ScenarioRuntime;
  runId: string;
  baseline: AgentFrameworkWorkflowBaseline;
  prepare(context: {
    baseline: SessionWorkflowState;
    current: SessionWorkflowState;
    attempt: number;
  }): SessionWorkflowState | Promise<SessionWorkflowState>;
  dispatch(workflow: SessionWorkflowState, expectedSnapshotRevision: number): Promise<Result>;
}): Promise<Result> {
  let current = input.baseline.state;
  let revision = input.baseline.revision;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next = await input.prepare({ baseline: input.baseline.state, current, attempt });
    try {
      return await input.dispatch(next, revision);
    } catch (error) {
      if (!(error instanceof SnapshotRevisionConflictError)) throw error;
    }
    const snapshot = await input.runtime.snapshot(input.runId);
    current = sessionWorkflowStateFromJson(snapshot.stateSlices["session.workflow"]?.value);
    revision = snapshot.revision;
  }
  throw new Error("Agent Framework workflow dispatch did not converge after repeated revision conflicts");
}
