import type { ScenarioSnapshot } from "../../src/scenario/protocol/snapshot.js";
import type { ScenarioCommand } from "../../src/scenario/protocol/commands.js";
import {
  canonicalHookRunId,
  createHostHookScenarioCommand,
  createHostHookStartCommand,
} from "../../src/entrypoints/host-hook.js";
import { toJsonValue } from "../../src/scenario/protocol/common.js";
import {
  sessionWorkflowStateFromJson,
  type SessionWorkflowState,
  updateAgentFrameworkWorkflow,
} from "../../src/effects/session-workflow.js";
import { ScenarioRuntime } from "../../src/scenario/runtime/runtime.js";
import { createTestScenarioRuntime } from "./scenario-runtime.js";
import type { ToolLogEntry } from "../../src/utils/tool-log-types.js";
import { canonicalToolHistory } from "../../src/effects/tool-history.js";

export type CanonicalHookRun = {
  adapter: string;
  nativeSessionId: string;
  transcriptPath: string;
  projectDir: string;
};

/** Test facade over the same canonical journal used by native hook entrypoints. */
export function canonicalHookState(run: CanonicalHookRun): {
  load(): Promise<SessionWorkflowState>;
  update(update: (state: SessionWorkflowState) => SessionWorkflowState): Promise<void>;
  snapshot(): Promise<ScenarioSnapshot>;
  toolHistory(): Promise<ToolLogEntry[]>;
  setStateSlice(key: string, schemaId: string, value: unknown): Promise<void>;
} {
  const runtime = hookRuntime();
  const runId = canonicalHookRunId(run.adapter, run.transcriptPath);
  return {
    async load() {
      const snapshot = await ensureRun(runtime, runId, run);
      return sessionWorkflowStateFromJson(snapshot.stateSlices["session.workflow"]?.value);
    },
    async update(update) {
      await ensureRun(runtime, runId, run);
      await updateAgentFrameworkWorkflow(runtime, runId, "test.canonicalHookState", update);
    },
    async snapshot() {
      return ensureRun(runtime, runId, run);
    },
    async toolHistory() {
      const snapshot = await ensureRun(runtime, runId, run);
      return canonicalToolHistory(snapshot);
    },
    async setStateSlice(key, schemaId, value) {
      await ensureRun(runtime, runId, run);
      await runtime.dispatch(command(run, runId, {
        type: "stateSliceChanged",
        key,
        schemaId,
        status: "validated",
        source: "test.canonicalHookState",
        visibility: "localSensitive",
        value: toJsonValue(value),
        diagnostics: [],
      }));
    },
  };
}

function hookRuntime(): ScenarioRuntime {
  const root = process.env.AGENT_FRAMEWORK_SCENARIO_ROOT;
  if (!root) throw new Error("Canonical hook tests must set AGENT_FRAMEWORK_SCENARIO_ROOT");
  return createTestScenarioRuntime({ root });
}

async function ensureRun(
  runtime: ScenarioRuntime,
  runId: string,
  run: CanonicalHookRun,
): Promise<ScenarioSnapshot> {
  await runtime.ensureRunStarted(createHostHookStartCommand({
    runId,
    adapter: run.adapter,
    nativeSessionId: run.nativeSessionId,
    workingDir: run.projectDir,
    projectDir: run.projectDir,
  }));
  return runtime.snapshot(runId);
}

function command(
  run: CanonicalHookRun,
  runId: string,
  payload: ScenarioCommand["payload"],
): ScenarioCommand {
  return createHostHookScenarioCommand({
    runId,
    adapter: run.adapter,
    nativeSessionId: run.nativeSessionId,
  }, payload);
}
