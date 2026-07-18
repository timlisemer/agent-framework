import * as fs from "fs/promises";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  digestScenarioValue,
  eventBatchSchema,
  scenarioCommandSchema,
  scenarioProtocolSchemaDigest,
  scenarioSnapshotSchema,
  type EventBatch,
  type ScenarioCommand,
  type ScenarioRecord,
  type ScenarioSnapshot,
} from "../../src/scenario/protocol/index.js";
import { ScenarioRuntime } from "../../src/scenario/runtime/index.js";
import {
  createDeterministicPolicyExecutor,
  createTestScenarioRuntime,
} from "../helpers/scenario-runtime.js";
import {
  createTestStartRunCommandBuilder,
  testScenarioCommand as command,
  testStartRunCommand,
} from "../helpers/scenario-fixtures.js";
import {
  canonicalTranscriptFromSnapshot,
  RulePipelineEffectExecutor,
} from "../../src/effects/rule-pipeline-executor.js";
import {
  agentFrameworkEffectPlanner,
  projectHookRuleEffect,
  projectToolPolicyEffect,
} from "../../src/effects/rule-pipeline-contract.js";
import { readFeedbackEntries } from "../../src/scenario/store/feedback-store.js";
import {
  runFeedbackPath,
  runJournalPath,
  runSnapshotPath,
} from "../../src/scenario/store/paths.js";
import {
  RunStore,
  type OpenRun,
  type OpenRunResult,
  type RunStoreTransactionProposal,
  type RunStoreTransactionResult,
} from "../../src/scenario/store/run-store.js";
import { RunRegistry } from "../../src/scenario/store/run-registry.js";
import type {
  RunManifest,
  RunRegistryEntry,
} from "../../src/scenario/store/types.js";
import type { PreToolRule } from "../../src/rules/types.js";
import {
  AGENT_FRAMEWORK_HOST_EXTENSION_ID,
  agentFrameworkHostCommand,
} from "../../src/effects/host-command.js";
import {
  AGENT_FRAMEWORK_RULE_EXTENSION_ID,
  AGENT_FRAMEWORK_RULE_PIPELINE_STATE_KEY,
  agentFrameworkRulePipelineState,
} from "../../src/effects/rule-observability.js";
import {
  cleanupTemporaryTestRoots,
  createTemporaryTestRoot,
} from "../helpers/temporary-root.js";
import {
  canonicalRuleStatusLineEntries,
  filterRuleStatusLineEntries,
} from "../../src/scripts/statusline-projection.js";
import {
  mergeSessionWorkflowChanges,
  sessionWorkflowDefaults,
  sessionWorkflowStateFromJson,
  updateAgentFrameworkWorkflow,
} from "../../src/effects/session-workflow.js";

const roots: string[] = [];
const runtimeStartCommand = createTestStartRunCommandBuilder({
  commandId: "start",
  source: { kind: "gateway" },
  payload: {
    runtimeHome: { kind: "managed", configuration: { profile: "default" } },
    configuration: { fallbackPolicy: "deny" },
  },
});

class CrashAfterCommitStore extends RunStore {
  private armed = false;

  public arm(): void {
    this.armed = true;
  }

  public override async transact<T>(
    runId: string,
    callback: (run: OpenRun) => Promise<RunStoreTransactionProposal<T>>,
  ): Promise<RunStoreTransactionResult<T>> {
    const result = await super.transact(runId, callback);
    if (this.armed) {
      this.armed = false;
      throw new Error("simulated process exit after commit");
    }
    return result;
  }
}

class CrashAfterCreateStore extends RunStore {
  private armed = false;

  public arm(): void {
    this.armed = true;
  }

  public override async create(manifest: RunManifest, snapshot: ScenarioSnapshot): Promise<void> {
    await super.create(manifest, snapshot);
    if (this.armed) {
      this.armed = false;
      throw new Error("simulated process exit after create");
    }
  }
}

class HeartbeatFailureStore extends RunStore {
  private armed = false;

  public arm(): void {
    this.armed = true;
  }

  public override async transact<T>(
    runId: string,
    callback: (run: OpenRun) => Promise<RunStoreTransactionProposal<T>>,
  ): Promise<RunStoreTransactionResult<T>> {
    return super.transact(runId, async (run) => {
      const proposed = await callback(run);
      if (!this.armed) return proposed;
      this.armed = false;
      const ownerPath = path.join(this.runDir(runId), ".write.lock", "owner.json");
      const owner = await fs.readFile(ownerPath, "utf8");
      await fs.rm(ownerPath);
      await fs.mkdir(ownerPath);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      await fs.rm(ownerPath, { recursive: true });
      await fs.writeFile(ownerPath, owner, "utf8");
      return proposed;
    });
  }
}

class FailEffectResultBeforeCommitStore extends RunStore {
  public readonly failure = new Error("simulated effect-result persistence outage");
  private armed = true;

  public override async transact<T>(
    runId: string,
    callback: (run: OpenRun) => Promise<RunStoreTransactionProposal<T>>,
  ): Promise<RunStoreTransactionResult<T>> {
    return super.transact(runId, async (run) => {
      const proposed = await callback(run);
      const persistsEffectResult = proposed.records.some((record) => {
        if (record.eventType !== "command.accepted") return false;
        const accepted = scenarioCommandSchema.safeParse(record.payload.command);
        return accepted.success && accepted.data.payload.type === "effectResultSupplied";
      });
      if (this.armed && persistsEffectResult) {
        this.armed = false;
        throw this.failure;
      }
      return proposed;
    });
  }
}

class FailNextRunRegistry extends RunRegistry {
  private armed = false;

  public arm(): void {
    this.armed = true;
  }

  public override async append(
    manifest: RunManifest,
    operation: RunRegistryEntry["operation"],
  ): Promise<void> {
    if (this.armed) {
      this.armed = false;
      throw new Error("simulated registry outage");
    }
    await super.append(manifest, operation);
  }
}

afterEach(async () => {
  await cleanupTemporaryTestRoots(roots);
});

async function runtime(): Promise<{ runtime: ScenarioRuntime; root: string }> {
  const root = await createTemporaryTestRoot(roots, "scenario-runtime-");
  let id = 0;
  return {
    root,
    runtime: createTestScenarioRuntime({ root, idFactory: () => `generated-${++id}` }),
  };
}

async function start(runtime: ScenarioRuntime, runId = "run-1"): Promise<void> {
  await runtime.dispatch(runtimeStartCommand(runId));
}

async function waitForCondition(condition: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("ScenarioRuntime", () => {
  it("rejects an incompatible protocol digest before creating the runtime root", async () => {
    const temporaryDir = await createTemporaryTestRoot(roots, "scenario-runtime-schema-digest-");
    const root = path.join(temporaryDir, "runtime");
    const scenario = createTestScenarioRuntime({ root });
    const incompatibleDigest = `sha256:${"0".repeat(64)}`;

    await expect(scenario.dispatch(testStartRunCommand({
      runId: "incompatible-schema-run",
      payload: { schemaDigest: incompatibleDigest },
    }))).rejects.toThrow(
      `startRun schemaDigest must equal the current Scenario protocol digest ${scenarioProtocolSchemaDigest()}`,
    );
    await expect(fs.access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails policy effects closed when no executor is configured", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-no-policy-executor-");
    const runtime = new ScenarioRuntime({ root, effectPlanner: agentFrameworkEffectPlanner });
    await start(runtime, "no-policy-executor-run");
    expect((await runtime.snapshot("no-policy-executor-run")).stateSlices["session.workflow"])
      .toBeUndefined();
    const input = { command: "pwd" };

    await expect(runtime.dispatch(command("no-policy-executor-run", "tool", {
      type: "toolRequested",
      toolCallId: "tool-1",
      turnId: null,
      name: "Bash",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: false,
    }))).resolves.toEqual({
      status: "failed",
      reason: "Unsupported scenario effect: rulePipeline.evaluate",
    });
    const snapshot = await runtime.snapshot("no-policy-executor-run");
    expect(snapshot.toolCalls).toMatchObject([{
      id: "tool-1",
      status: "failed",
      error: "Unsupported scenario effect: rulePipeline.evaluate",
      authorization: { policy: "failed", final: "failed" },
    }]);
    const transcript = canonicalTranscriptFromSnapshot(snapshot)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        message?: { content?: Array<{ type?: string; tool_use_id?: string; is_error?: boolean }> };
      });
    expect(transcript).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({
        content: [expect.objectContaining({
          type: "tool_result",
          tool_use_id: "tool-1",
          is_error: true,
        })],
      }),
    }));
  });

  it("leaves a successful effect recoverable when terminal result persistence fails before commit", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-effect-result-outage-");
    const store = new FailEffectResultBeforeCommitStore(root);
    let executions = 0;
    const runtime = createTestScenarioRuntime({
      root,
      store,
      effectExecutor: {
        async execute() {
          executions += 1;
          return { result: { executed: true }, metadata: { executor: "test" } };
        },
      },
    });
    await start(runtime, "effect-result-outage-run");

    await expect(runtime.dispatch(command("effect-result-outage-run", "request-effect", {
      type: "requestEffect",
      effectId: "recoverable-effect",
      effectType: "fixture.effect",
      parameters: { input: true },
    }))).rejects.toBe(store.failure);

    expect(executions).toBe(1);
    expect((await runtime.snapshot("effect-result-outage-run")).effects).toMatchObject([{
      effectId: "recoverable-effect",
      status: "started",
      error: null,
    }]);
    expect((await runtime.snapshot("effect-result-outage-run")).effects[0]).not.toHaveProperty("result");
    expect((await runtime.recordsAfter("effect-result-outage-run", 0)).some((record) =>
      record.eventType === "effect.failed" || record.eventType === "effect.completed"
    )).toBe(false);
  });

  it("merges concurrent nested drift targets and additive counter increments", () => {
    const base = sessionWorkflowDefaults();
    const firstCommitted = {
      ...base,
      toolCallCount: 1,
      editIntentOverturnCount: 1,
      driftState: { "/first.ts": { level: 1 as const } },
      driftReductionCredits: { "/first.ts": 2 },
    };
    const concurrentIncoming = {
      ...base,
      toolCallCount: 1,
      editIntentOverturnCount: 1,
      driftState: { "/second.ts": { level: 2 as const } },
      driftReductionCredits: { "/second.ts": 3 },
    };

    expect(mergeSessionWorkflowChanges(base, concurrentIncoming, firstCommitted)).toMatchObject({
      toolCallCount: 2,
      editIntentOverturnCount: 2,
      currentEditIntent: true,
      driftState: {
        "/first.ts": { level: 1 },
        "/second.ts": { level: 2 },
      },
      driftReductionCredits: { "/first.ts": 2, "/second.ts": 3 },
    });
  });

  it("uses the shared rule registry effect to author policy and trace records", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-rules-");
    const runtime = createTestScenarioRuntime({
      root,
      effectExecutor: new RulePipelineEffectExecutor({
        rules: [{
          name: "fixture-deny",
          displayName: "Fixture deny",
          priority: 1,
          appealable: false,
          usesLlm: false,
          version: "1",
          configuration: {},
          promptSection: "",
          async check(context) {
            await context.stateManager.update((state) => ({
              ...state,
              currentEditIntent: true,
              frustrationStreak: 2,
              driftState: { "/workspace/file.ts": { level: 1 } },
            }));
            return { fastDeny: "denied by shared policy" };
          },
        }],
      }),
    });
    await start(runtime, "rule-run");
    const input = { command: "rm important.txt" };
    const result = await runtime.dispatch(command("rule-run", "rule-tool", {
      type: "toolRequested",
      toolCallId: "rule-tool-1",
      turnId: null,
      name: "Bash",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: false,
    }));

    expect(result).toEqual({ status: "denied", reason: "denied by shared policy" });
    const snapshot = await runtime.snapshot("rule-run");
    expect(snapshot.toolCalls[0].authorization).toMatchObject({
      policy: "denied",
      final: "denied",
    });
    const ruleState = agentFrameworkRulePipelineState(snapshot);
    expect(ruleState.registry).toMatchObject([{ ruleId: "agent-framework.rule.fixture-deny" }]);
    expect(ruleState.evaluations.at(-1)).toMatchObject({
      status: "completed",
      result: "fastDeny",
    });
    expect(snapshot.stateSlices["session.workflow"].status).toBe("validated");
    expect(sessionWorkflowStateFromJson(snapshot.stateSlices["session.workflow"].value)).toMatchObject({
      currentEditIntent: true,
      frustrationStreak: 2,
      driftState: { "/workspace/file.ts": { level: 1 } },
    });
    expect(Object.keys(snapshot.stateSlices)).not.toEqual(expect.arrayContaining([
      "prediction.current",
      "prediction.queue",
      "prediction.context",
      "drift.intent",
      "sentiment.frustration",
      "conversation.recent",
      "reasoning.history",
      "plan.artifacts",
      "statusline.projection",
    ]));
  });

  it("persists one canonical journal and emits cursor-safe committed batches", async () => {
    const context = await runtime();
    const batches: Array<{ from: number; to: number; revision: number }> = [];
    context.runtime.subscribe("run-1", (batch) => {
      batches.push({ from: batch.fromSeq, to: batch.toSeq, revision: batch.resultingSnapshotRevision });
    });

    await start(context.runtime);
    const input = { path: "/workspace/file.ts", nested: { lines: [1, 2] } };
    const result = await context.runtime.dispatch(command("run-1", "tool", {
      type: "toolRequested",
      toolCallId: "tool-1",
      turnId: "turn-1",
      name: "Edit",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: true,
    }, "2026-07-15T12:00:01.000Z"));

    expect(result.status).toBe("userDecisionRequired");
    const snapshot = await context.runtime.snapshot("run-1");
    expect(snapshot.recoveryDiagnostics).toEqual([]);
    expect(snapshot.toolCalls[0]).toMatchObject({
      input,
      status: "waiting",
      authorization: { policy: "allowed", user: "pending", final: "pending" },
    });
    expect(snapshot.lastRecordSeq).toBe(21);
    expect(batches[0]).toEqual({ from: 1, to: 9, revision: 1 });
    expect(batches.at(-1)?.to).toBe(snapshot.lastRecordSeq);
    expect(batches.every((batch, index) => index === 0 || batch.from === batches[index - 1].to + 1)).toBe(true);
    const replayBatches = await context.runtime.committedBatchesAfter("run-1", 0);
    expect(replayBatches.length).toBeGreaterThan(1);
    expect(replayBatches.every((batch) => new Set(batch.records.map((record) => record.commandId)).size === 1))
      .toBe(true);
    expect(replayBatches.every((batch, index) =>
      index === 0 ||
      (batch.fromSeq === replayBatches[index - 1].toSeq + 1 &&
        batch.baseSnapshotRevision === replayBatches[index - 1].resultingSnapshotRevision)
    )).toBe(true);
    const journal = await fs.readFile(runJournalPath("run-1", context.root), "utf8");
    const journalFrames = journal.trim().split("\n").map((line) => JSON.parse(line) as ScenarioRecord[]);
    expect(journalFrames).toHaveLength(replayBatches.length);
    expect(journalFrames.flat()).toHaveLength(snapshot.lastRecordSeq);
    expect(journalFrames.every((frame) => new Set(frame.map((record) => record.commandId)).size === 1))
      .toBe(true);
  });

  it("publishes late heartbeat diagnostics as a separate revision-contiguous batch", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-heartbeat-publication-");
    const store = new HeartbeatFailureStore(root, {
      staleAfterMs: 30,
      timeoutMs: 100,
      retryMs: 1,
    });
    const runtime = createTestScenarioRuntime({ root, store });
    await start(runtime, "heartbeat-publication-run");
    const initial = await runtime.snapshot("heartbeat-publication-run");
    const published: Array<{ batch: EventBatch; snapshot: ScenarioSnapshot }> = [];
    runtime.subscribe("heartbeat-publication-run", (batch, snapshot) => {
      published.push({
        batch: eventBatchSchema.parse(batch),
        snapshot: scenarioSnapshotSchema.parse(snapshot),
      });
    });
    store.arm();

    await runtime.dispatch(command("heartbeat-publication-run", "heartbeat-plan", {
      type: "planStateChanged",
      data: { step: "heartbeat" },
    }));

    expect(published).toHaveLength(2);
    const [semantic, diagnostic] = published;
    expect(semantic.batch.records.some((record) => record.eventType === "store.diagnostic")).toBe(false);
    expect(diagnostic.batch.records).toEqual([
      expect.objectContaining({
        eventType: "store.diagnostic",
        payload: expect.objectContaining({
          message: expect.stringContaining("Run lock heartbeat failed"),
          source: "runLock",
        }),
      }),
    ]);
    expect(semantic.batch.baseSnapshotRevision).toBe(initial.revision);
    expect(semantic.batch.resultingSnapshotRevision).toBe(initial.revision + 1);
    expect(diagnostic.batch.baseSnapshotRevision).toBe(semantic.batch.resultingSnapshotRevision);
    expect(diagnostic.batch.resultingSnapshotRevision).toBe(initial.revision + 2);
    expect(diagnostic.batch.fromSeq).toBe(semantic.batch.toSeq + 1);
    expect(semantic.snapshot.revision).toBe(semantic.batch.resultingSnapshotRevision);
    expect(diagnostic.snapshot.revision).toBe(diagnostic.batch.resultingSnapshotRevision);
  });

  it("publishes read-triggered recovery before later command batches", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-read-recovery-");
    const runtime = createTestScenarioRuntime({ root });
    await start(runtime, "read-recovery-run");
    const initial = await runtime.snapshot("read-recovery-run");
    const published: Array<{ batch: EventBatch; snapshot: ScenarioSnapshot }> = [];
    runtime.subscribe("read-recovery-run", (batch, snapshot) => {
      published.push({
        batch: eventBatchSchema.parse(batch),
        snapshot: scenarioSnapshotSchema.parse(snapshot),
      });
    });
    const snapshotPath = runSnapshotPath("read-recovery-run", root);
    const damaged = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    damaged.lastRecordSeq = 0;
    await fs.writeFile(snapshotPath, JSON.stringify(damaged), "utf8");

    const recovered = await runtime.snapshot("read-recovery-run");
    await runtime.dispatch(command("read-recovery-run", "after-read-recovery", {
      type: "planStateChanged",
      data: { step: "after recovery" },
    }));

    expect(recovered.revision).toBe(initial.revision + 2);
    expect(published).toHaveLength(3);
    expect(published[0]?.batch.records.map((record) => record.eventType))
      .toEqual(["recovery.completed"]);
    expect(published[1]?.batch.records.map((record) => record.eventType))
      .toEqual(["store.diagnostic"]);
    expect(published[2]?.batch.records.map((record) => record.eventType))
      .toContain("plan.stateChanged");
    let previousSeq = initial.lastRecordSeq;
    let previousRevision = initial.revision;
    for (const publication of published) {
      expect(publication.batch.fromSeq).toBe(previousSeq + 1);
      expect(publication.batch.baseSnapshotRevision).toBe(previousRevision);
      expect(publication.batch.resultingSnapshotRevision).toBe(previousRevision + 1);
      expect(publication.snapshot.revision).toBe(publication.batch.resultingSnapshotRevision);
      previousSeq = publication.batch.toSeq;
      previousRevision = publication.batch.resultingSnapshotRevision;
    }
  });

  it("records provider-started tools as observations without claiming policy enforcement", async () => {
    const context = await runtime();
    await start(context.runtime, "observed-run");
    const input = { command: "pwd" };

    await context.runtime.dispatch(command("observed-run", "observed-tool", {
      type: "toolExecutionObserved",
      toolCallId: "observed-tool-1",
      turnId: "turn-1",
      name: "Bash",
      input,
      inputDigest: digestScenarioValue(input),
    }));

    const snapshot = await context.runtime.snapshot("observed-run");
    expect(snapshot.toolCalls).toMatchObject([{
      id: "observed-tool-1",
      status: "running",
      authorization: { policy: "notEnforced", final: "observed" },
    }]);
    expect(snapshot.effects).toEqual([]);
    expect((await context.runtime.recordsAfter("observed-run", 0)).some((record) =>
      record.eventType === "effect.requested"
    )).toBe(false);
  });

  it("isolates subscriber failures and continues registry publication and effects", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-subscriber-");
    let id = 0;
    const runtime = createTestScenarioRuntime({
      root,
      idFactory: () => `subscriber-${++id}`,
      effectExecutor: {
        async execute() {
          return { result: { completed: true } };
        },
      },
    });
    await start(runtime, "subscriber-run");
    const received: Array<{ fromSeq: number; toSeq: number; eventTypes: string[] }> = [];
    runtime.subscribe("subscriber-run", () => {
      throw new Error("broken publication sink");
    });
    runtime.subscribe("subscriber-run", (batch) => {
      received.push({
        fromSeq: batch.fromSeq,
        toSeq: batch.toSeq,
        eventTypes: batch.records.map((record) => record.eventType),
      });
    });

    await expect(runtime.dispatch(command("subscriber-run", "subscriber-effect", {
      type: "requestEffect",
      effectId: "subscriber-effect-1",
      effectType: "fixture",
      parameters: {},
    }))).resolves.toEqual({ status: "accepted" });

    const snapshot = await runtime.snapshot("subscriber-run");
    expect(snapshot.effects).toMatchObject([{ effectId: "subscriber-effect-1", status: "completed" }]);
    expect(snapshot.recoveryDiagnostics).toContain("Scenario subscriber failed: broken publication sink");
    expect(received.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < received.length; index += 1) {
      expect(received[index]?.fromSeq).toBe((received[index - 1]?.toSeq ?? 0) + 1);
    }
    expect(received.some((range) => range.eventTypes.includes("store.diagnostic"))).toBe(true);
    expect((await runtime.listRuns()).find((run) => run.runId === "subscriber-run")?.status).toBe("running");
  });

  it("reports diagnostic-batch subscriber failures without recursive publication", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-diagnostic-subscriber-");
    const backgroundErrors: Array<{
      error: unknown;
      context: { runId: string; operation: "diagnosticPublication" };
    }> = [];
    const runtime = createTestScenarioRuntime({
      root,
      onBackgroundError: (error, context) => backgroundErrors.push({ error, context }),
    });
    await start(runtime, "diagnostic-subscriber-run");
    runtime.subscribe("diagnostic-subscriber-run", (batch) => {
      if (batch.records.some((record) => record.eventType === "store.diagnostic")) {
        throw new Error("diagnostic publication sink failed");
      }
    });
    runtime.subscribe("diagnostic-subscriber-run", () => {
      throw new Error("primary publication sink failed");
    });

    await runtime.dispatch(command("diagnostic-subscriber-run", "diagnostic-trigger", {
      type: "providerStateObserved",
      data: { status: "ready" },
    }));

    expect(backgroundErrors).toMatchObject([{
      error: { message: "diagnostic publication sink failed" },
      context: {
        runId: "diagnostic-subscriber-run",
        operation: "diagnosticPublication",
      },
    }]);
    const diagnostics = (await runtime.recordsAfter("diagnostic-subscriber-run", 0))
      .filter((record) => record.eventType === "store.diagnostic");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.payload).toMatchObject({
      message: "Scenario subscriber failed: primary publication sink failed",
    });
  });

  it("publishes deeply immutable values independently to each subscriber", async () => {
    const context = await runtime();
    await start(context.runtime);
    let rejectedMutations = 0;
    context.runtime.subscribe("run-1", (batch, snapshot) => {
      try {
        (batch.records as unknown as ScenarioRecord[]).push(batch.records[0] as unknown as ScenarioRecord);
      } catch {
        rejectedMutations += 1;
      }
      try {
        (snapshot as unknown as { status: string }).status = "closed";
      } catch {
        rejectedMutations += 1;
      }
    });
    const observed: Array<{ recordCount: number; status: string }> = [];
    context.runtime.subscribe("run-1", (batch, snapshot) => {
      observed.push({ recordCount: batch.records.length, status: snapshot.status });
    });

    await context.runtime.dispatch(command("run-1", "immutable-publication", {
      type: "planStateChanged",
      data: { step: "immutable" },
    }));

    expect(rejectedMutations).toBe(2);
    expect(observed).toEqual([{ recordCount: 2, status: "running" }]);
  });

  it("is command-idempotent and records a user decision only once", async () => {
    const context = await runtime();
    await start(context.runtime);
    const input = { command: "cargo test" };
    await context.runtime.dispatch(command("run-1", "tool", {
      type: "toolRequested",
      toolCallId: "tool-1",
      turnId: null,
      name: "Bash",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: true,
    }));
    const decision = command("run-1", "decision", {
      type: "toolDecisionSubmitted",
      toolCallId: "tool-1",
      decision: "deny",
      reason: "Not now",
    });
    const first = await context.runtime.dispatch(decision);
    const firstSnapshot = await context.runtime.snapshot("run-1");
    const firstRecords = await context.runtime.recordsAfter("run-1", 0);
    const firstBatches = await context.runtime.committedBatchesAfter("run-1", 0);
    const second = await context.runtime.dispatch(decision);

    expect(first).toEqual(second);
    expect(first.status).toBe("denied");
    const snapshot = await context.runtime.snapshot("run-1");
    const records = await context.runtime.recordsAfter("run-1", 0);
    const batches = await context.runtime.committedBatchesAfter("run-1", 0);
    expect(snapshot.revision).toBe(firstSnapshot.revision);
    expect(snapshot.lastRecordSeq).toBe(firstSnapshot.lastRecordSeq);
    expect(records).toEqual(firstRecords);
    expect(batches).toEqual(firstBatches);
    expect(snapshot.toolCalls[0].authorization).toEqual({
      policy: "allowed",
      user: "denied",
      final: "denied",
      reason: "Not now",
    });
    expect(records.filter((record) => record.commandId === "decision"))
      .toHaveLength(3);
  });

  it("accepts only matching command retries and rejects command-ID collisions without mutation", async () => {
    const context = await runtime();
    await start(context.runtime);
    const originalPayload: Extract<ScenarioCommand["payload"], {
      type: "userMessageSubmitted" | "assistantMessageObserved" | "assistantMessageCompleted";
    }> = {
      type: "userMessageSubmitted",
      messageId: "message-1",
      turnId: "turn-1",
      content: "original",
      contentDigest: digestScenarioValue("original"),
    };
    const original = command("run-1", "message-collision", originalPayload);
    await context.runtime.dispatch(original);
    const before = {
      snapshot: await context.runtime.snapshot("run-1"),
      records: await context.runtime.recordsAfter("run-1", 0),
    };

    await expect(context.runtime.dispatch({
      ...original,
      recordedAt: "2026-07-16T12:00:00.000Z",
    })).resolves.toEqual({ status: "accepted" });
    await expect(context.runtime.dispatch({
      ...original,
      payload: {
        ...originalPayload,
        content: "conflicting",
        contentDigest: digestScenarioValue("conflicting"),
      },
    })).rejects.toThrow("Command ID collision: message-collision");

    expect(await context.runtime.snapshot("run-1")).toEqual(before.snapshot);
    expect(await context.runtime.recordsAfter("run-1", 0)).toEqual(before.records);
  });

  it.each(["running", "closed", "cancelled"] as const)(
    "rejects a differently identified startRun for an existing %s run without mutation",
    async (status) => {
      const context = await runtime();
      await start(context.runtime);
      if (status === "closed") {
        await context.runtime.dispatch(command("run-1", "close-before-restart", { type: "closeRun" }));
      }
      if (status === "cancelled") {
        await context.runtime.dispatch(command("run-1", "cancel-before-restart", { type: "cancelRun" }));
      }
      const before = {
        snapshot: await context.runtime.snapshot("run-1"),
        records: await context.runtime.recordsAfter("run-1", 0),
      };

      await expect(context.runtime.dispatch(command(
        "run-1",
        `restart-${status}`,
        testStartRunCommand({ payload: {
        workingDir: "/other",
        projectDir: "/other",
        engineVersion: "other",
        schemaDigest: scenarioProtocolSchemaDigest(),
        } }).payload,
      ))).rejects.toThrow("startRun requires a newly created run");

      expect(await context.runtime.snapshot("run-1")).toEqual(before.snapshot);
      expect(await context.runtime.recordsAfter("run-1", 0)).toEqual(before.records);
    },
  );

  it("preserves an identical startRun retry and rejects conflicting reuse of its command ID", async () => {
    const context = await runtime();
    const initialPayload = testStartRunCommand({ payload: {
      runtimeHome: { kind: "managed", configuration: { profile: "default" } },
      schemaDigest: scenarioProtocolSchemaDigest(),
      configuration: { fallbackPolicy: "deny" },
    } }).payload;
    const initial = command("run-1", "start", initialPayload);
    await context.runtime.dispatch(initial);
    const before = {
      snapshot: await context.runtime.snapshot("run-1"),
      records: await context.runtime.recordsAfter("run-1", 0),
    };

    await expect(context.runtime.dispatch({
      ...initial,
      recordedAt: "2026-07-16T12:00:00.000Z",
    })).resolves.toEqual({ status: "accepted" });
    await expect(context.runtime.dispatch({
      ...initial,
      payload: { ...initialPayload, projectDir: "/conflict" },
    })).rejects.toThrow("Command ID collision: start");
    expect(await context.runtime.snapshot("run-1")).toEqual(before.snapshot);
    expect(await context.runtime.recordsAfter("run-1", 0)).toEqual(before.records);
  });

  it("repairs a persisted created run after interruption before run.started", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-created-repair-");
    const store = new CrashAfterCreateStore(root);
    store.arm();
    const scenario = createTestScenarioRuntime({ root, store });
    const initial = testStartRunCommand({
      runId: "created-repair",
      commandId: "start-created-repair",
      source: { kind: "scenarioFixture", adapter: "direct" },
      payload: {
      schemaDigest: scenarioProtocolSchemaDigest(),
      },
    });

    await expect(scenario.dispatch(initial)).rejects.toThrow("simulated process exit after create");
    expect((await scenario.snapshot(initial.runId)).status).toBe("created");
    await expect(scenario.ensureRunStarted(initial)).resolves.toEqual({ status: "accepted" });
    expect((await scenario.snapshot(initial.runId)).status).toBe("running");
    expect((await scenario.recordsAfter(initial.runId, 0)).filter((record) =>
      record.eventType === "run.started"
    )).toHaveLength(1);
  });

  it("lets simultaneous equivalent initializers share one run.started transition", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-concurrent-start-");
    const left = createTestScenarioRuntime({ root });
    const right = createTestScenarioRuntime({ root });
    const payload = testStartRunCommand({ payload: {
      schemaDigest: scenarioProtocolSchemaDigest(),
      configuration: { owner: "shared" },
    } }).payload;

    await expect(Promise.all([
      left.ensureRunStarted(command("concurrent-start", "start-left", payload)),
      right.ensureRunStarted(command("concurrent-start", "start-right", payload)),
    ])).resolves.toEqual([{ status: "accepted" }, { status: "accepted" }]);
    expect((await left.snapshot("concurrent-start")).status).toBe("running");
    expect((await left.recordsAfter("concurrent-start", 0)).filter((record) =>
      record.eventType === "run.started"
    )).toHaveLength(1);
  });

  it("lets only one of two simultaneous conflicting initializers establish run identity", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-concurrent-conflicting-start-");
    const left = createTestScenarioRuntime({ root });
    const right = createTestScenarioRuntime({ root });
    const leftStart = testStartRunCommand({
      runId: "concurrent-conflicting-start",
      commandId: "concurrent-conflicting-left",
      payload: { workingDir: "/left/work", projectDir: "/left/project" },
    });
    const rightStart = testStartRunCommand({
      runId: leftStart.runId,
      commandId: "concurrent-conflicting-right",
      payload: { workingDir: "/right/work", projectDir: "/right/project" },
    });

    const results = await Promise.allSettled([
      left.ensureRunStarted(leftStart),
      right.ensureRunStarted(rightStart),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const snapshot = await left.snapshot(leftStart.runId);
    expect([
      ["/left/work", "/left/project"],
      ["/right/work", "/right/project"],
    ]).toContainEqual([snapshot.identity.workingDir, snapshot.identity.projectDir]);
    expect((await left.recordsAfter(leftStart.runId, 0)).filter((record) =>
      record.eventType === "run.started"
    )).toHaveLength(1);
  });

  it.each([
    { field: "workingDir" as const, original: "/workspace/one", conflict: "/workspace/two" },
    { field: "projectDir" as const, original: "/project/one", conflict: "/project/two" },
  ])("rejects a conflicting $field initializer without mutation", async ({
    field,
    original,
    conflict,
  }) => {
    const root = await createTemporaryTestRoot(roots, `scenario-conflicting-${field}-`);
    const scenario = createTestScenarioRuntime({ root });
    const initial = testStartRunCommand({
      runId: `conflicting-${field}`,
      commandId: `start-${field}-original`,
      payload: { [field]: original },
    });
    await scenario.ensureRunStarted(initial);
    const before = {
      snapshot: await scenario.snapshot(initial.runId),
      records: await scenario.recordsAfter(initial.runId, 0),
    };
    const conflicting = testStartRunCommand({
      runId: initial.runId,
      commandId: `start-${field}-conflict`,
      payload: {
        ...initial.payload,
        [field]: conflict,
      },
    });

    await expect(scenario.ensureRunStarted(conflicting)).rejects.toThrow(/initializer conflicts/i);
    expect(await scenario.snapshot(initial.runId)).toEqual(before.snapshot);
    expect(await scenario.recordsAfter(initial.runId, 0)).toEqual(before.records);
  });

  it("recomputes overlapping workflow mutations after revision conflicts", async () => {
    const context = await runtime();
    await start(context.runtime);
    let ready = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pause = async () => {
      ready += 1;
      if (ready === 2) release();
      await gate;
    };
    await Promise.all([
      updateAgentFrameworkWorkflow(context.runtime, "run-1", "concurrent.intent", async (state) => {
        await pause();
        return { ...state, currentEditIntent: true };
      }),
      updateAgentFrameworkWorkflow(context.runtime, "run-1", "concurrent.timestamp", async (state) => {
        await pause();
        return { ...state, lastUserMessageTimestamp: 42 };
      }),
    ]);
    const state = sessionWorkflowStateFromJson(
      (await context.runtime.snapshot("run-1")).stateSlices["session.workflow"]?.value,
    );
    expect(state.currentEditIntent).toBe(true);
    expect(state.lastUserMessageTimestamp).toBe(42);
  });

  it("enforces resume and post-terminal mutation transitions without journal changes", async () => {
    const context = await runtime();
    await start(context.runtime);
    const running = {
      snapshot: await context.runtime.snapshot("run-1"),
      records: await context.runtime.recordsAfter("run-1", 0),
    };
    await expect(context.runtime.dispatch(command("run-1", "resume-running", { type: "resumeRun" })))
      .rejects.toThrow("resumeRun is not allowed while run status is running");
    expect(await context.runtime.snapshot("run-1")).toEqual(running.snapshot);
    expect(await context.runtime.recordsAfter("run-1", 0)).toEqual(running.records);

    await context.runtime.dispatch(command("run-1", "close-for-lifecycle", { type: "closeRun" }));
    const closed = {
      snapshot: await context.runtime.snapshot("run-1"),
      records: await context.runtime.recordsAfter("run-1", 0),
    };
    await expect(context.runtime.dispatch(command("run-1", "message-after-close", {
      type: "userMessageSubmitted",
      messageId: "closed-message",
      turnId: null,
      content: "too late",
      contentDigest: digestScenarioValue("too late"),
    }))).rejects.toThrow("userMessageSubmitted is not allowed while run status is closed");
    expect(await context.runtime.snapshot("run-1")).toEqual(closed.snapshot);
    expect(await context.runtime.recordsAfter("run-1", 0)).toEqual(closed.records);

    await expect(context.runtime.dispatch(command("run-1", "resume-closed", { type: "resumeRun" })))
      .resolves.toEqual({ status: "accepted" });
    expect((await context.runtime.snapshot("run-1")).status).toBe("running");
  });

  it("builds committed batches from one locked snapshot-and-journal view", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-batch-view-");
    let capture!: (run: OpenRun) => void;
    let release!: () => void;
    const captured = new Promise<OpenRun>((resolve) => { capture = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    class PausingRunStore extends RunStore {
      public pauseNextOpen = false;

      public override async open(runId: string): Promise<OpenRunResult> {
        const opened = await super.open(runId);
        if (this.pauseNextOpen) {
          this.pauseNextOpen = false;
          capture(opened.run);
          await barrier;
        }
        return opened;
      }
    }
    const store = new PausingRunStore(root);
    const scenario = createTestScenarioRuntime({ root, store });
    await start(scenario);
    await scenario.dispatch(command("run-1", "before-read", {
      type: "userMessageSubmitted",
      messageId: "message-before",
      turnId: "turn-before",
      content: "before",
      contentDigest: digestScenarioValue("before"),
    }));

    store.pauseNextOpen = true;
    const batchesPromise = scenario.committedBatchesAfter("run-1", 0);
    const consistentView = await captured;
    await scenario.dispatch(command("run-1", "concurrent-commit", {
      type: "userMessageSubmitted",
      messageId: "message-concurrent",
      turnId: "turn-concurrent",
      content: "concurrent",
      contentDigest: digestScenarioValue("concurrent"),
    }));
    release();

    const batches = await batchesPromise;
    expect(batches.at(-1)?.resultingSnapshotRevision).toBe(consistentView.snapshot.revision);
    expect(batches.flatMap((batch) => batch.records).some((record) => record.commandId === "concurrent-commit"))
      .toBe(false);
    expect((await scenario.snapshot("run-1")).revision).toBe(consistentView.snapshot.revision + 1);
  });

  it("rejects malformed canonical session workflow state without committing it", async () => {
    const context = await runtime();
    await start(context.runtime);
    const malformed = command("run-1", "malformed-workflow", {
      type: "stateSliceChanged",
      key: "session.workflow",
      schemaId: "agent-framework://state/session-workflow",
      status: "validated",
      source: "test",
      visibility: "localSensitive",
      value: { toolCallCount: "not-a-number" },
      diagnostics: [],
    });

    await expect(context.runtime.dispatch(malformed)).rejects.toThrow();
    expect((await context.runtime.recordsAfter("run-1", 0)).some((record) =>
      record.commandId === malformed.commandId
    )).toBe(false);
  });

  it("keeps manifest and snapshot running after a recoverable runtime error", async () => {
    const context = await runtime();
    await start(context.runtime);
    const input = { command: "retryable" };
    await context.runtime.dispatch(command("run-1", "pending-tool", {
      type: "toolRequested",
      toolCallId: "pending-tool",
      turnId: "pending-turn",
      name: "Bash",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: true,
    }));
    await context.runtime.dispatch(command("run-1", "recoverable-error", {
      type: "runtimeErrorObserved",
      data: { code: "temporary", message: "retry later", recoverable: true },
    }));

    const snapshot = await context.runtime.snapshot("run-1");
    expect(snapshot.status).toBe("running");
    expect(snapshot.toolCalls).toMatchObject([{
      id: "pending-tool",
      status: "waiting",
      authorization: { policy: "allowed", user: "pending", final: "pending" },
    }]);
    expect((await context.runtime.listRuns()).find((run) => run.runId === "run-1")?.status)
      .toBe("running");
  });

  it("rejects mismatched command and native transcript digests without mutation", async () => {
    const context = await runtime();
    await start(context.runtime);
    const validInput = { command: "pwd" };
    const payloads: ScenarioCommand["payload"][] = [
      {
        type: "assistantMessageObserved",
        messageId: "bad-message",
        turnId: "bad-turn",
        content: "actual content",
        contentDigest: digestScenarioValue("different content"),
      },
      {
        type: "toolRequested",
        toolCallId: "bad-tool",
        turnId: "bad-turn",
        name: "Bash",
        input: validInput,
        inputDigest: digestScenarioValue({ command: "different" }),
        requiresUserDecision: false,
      },
      {
        type: "nativeTranscriptObserved",
        data: {
          messages: [{
            id: "bad-native-message",
            turnId: "bad-turn",
            role: "assistant",
            content: "native content",
            contentDigest: digestScenarioValue("different native content"),
            status: "completed",
          }],
          tools: [],
        },
      },
      {
        type: "nativeTranscriptObserved",
        data: {
          messages: [],
          tools: [{
            id: "bad-native-tool",
            turnId: "bad-turn",
            name: "Bash",
            input: validInput,
            inputDigest: digestScenarioValue({ command: "different" }),
            status: "requested",
            output: [],
            error: null,
          }],
        },
      },
      {
        type: "nativeTranscriptObserved",
        data: {
          messages: [],
          tools: [],
          digest: digestScenarioValue({ invalid: "aggregate transcript digest" }),
        },
      },
      {
        type: "extensionCommand",
        extensionId: AGENT_FRAMEWORK_HOST_EXTENSION_ID,
        data: {
          type: "hostPreToolUse",
          workflow: {},
          context: {},
          toolCallId: "bad-host-pre-tool",
          turnId: null,
          name: "Bash",
          input: validInput,
          inputDigest: digestScenarioValue({ command: "different" }),
          requiresUserDecision: false,
        },
      },
      {
        type: "extensionCommand",
        extensionId: AGENT_FRAMEWORK_HOST_EXTENSION_ID,
        data: {
          type: "hostPostToolUse",
          workflow: {},
          context: {},
          toolCallId: "bad-host-post-tool",
          name: "Bash",
          input: validInput,
          inputDigest: digestScenarioValue({ command: "different" }),
          outcome: "completed",
          error: null,
        },
      },
      {
        type: "extensionCommand",
        extensionId: AGENT_FRAMEWORK_HOST_EXTENSION_ID,
        data: {
          type: "hostUserPromptSubmitted",
          workflow: {},
          context: {},
          messageId: "bad-host-user-message",
          prompt: "actual prompt",
          contentDigest: digestScenarioValue("different prompt"),
        },
      },
    ];
    const before = {
      snapshot: await context.runtime.snapshot("run-1"),
      records: await context.runtime.recordsAfter("run-1", 0),
    };

    for (const [index, payload] of payloads.entries()) {
      await expect(context.runtime.dispatch(command("run-1", `bad-digest-${index}`, payload)))
        .rejects.toThrow(/digest mismatch/);
      expect(await context.runtime.snapshot("run-1")).toEqual(before.snapshot);
      expect(await context.runtime.recordsAfter("run-1", 0)).toEqual(before.records);
    }
  });

  it("executes effects outside the journal transaction and records their lifecycle", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-effect-");
    let id = 0;
    const runtime = createTestScenarioRuntime({
      root,
      idFactory: () => `effect-generated-${++id}`,
      effectExecutor: {
        async execute(request) {
          expect(request).toMatchObject({ effectId: "effect-1", effectType: "clock", parameters: { zone: "UTC" } });
          expect(request.signal).toBeInstanceOf(AbortSignal);
          return { result: { now: "12:00" }, metadata: { provider: "fixture" } };
        },
      },
    });
    await start(runtime);
    const result = await runtime.dispatch(command("run-1", "effect-command", {
      type: "requestEffect",
      effectId: "effect-1",
      effectType: "clock",
      parameters: { zone: "UTC" },
    }));

    expect(result.status).toBe("accepted");
    expect((await runtime.snapshot("run-1")).effects[0]).toMatchObject({
      status: "completed",
      result: { now: "12:00" },
    });
  });

  it("recovers a committed generic effect after process exit and command retry", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-effect-retry-");
    const crashStore = new CrashAfterCommitStore(root);
    const crashedRuntime = createTestScenarioRuntime({ root, store: crashStore });
    await start(crashedRuntime);
    const request = {
      ...command("run-1", "recover-generic-effect", {
      type: "requestEffect",
      effectId: "recover-generic-effect-1",
      effectType: "fixture",
      parameters: { value: 42 },
      }),
      source: {
        kind: "providerSdk" as const,
        provider: "codex",
        nativeSessionId: "resumed-native-session",
      },
    };
    crashStore.arm();
    await expect(crashedRuntime.dispatch(request)).rejects.toThrow("simulated process exit after commit");
    expect((await crashedRuntime.snapshot("run-1")).effects[0]).toMatchObject({ status: "requested" });

    let executions = 0;
    const recoveredRuntime = createTestScenarioRuntime({
      root,
      effectExecutor: {
        async execute(effect) {
          executions += 1;
          expect(effect.parameters).toEqual({ value: 42 });
          return { result: { recovered: true } };
        },
      },
    });
    await expect(recoveredRuntime.dispatch(request)).resolves.toEqual({ status: "accepted" });
    expect(executions).toBe(1);
    expect((await recoveredRuntime.snapshot("run-1")).effects[0]).toMatchObject({
      status: "completed",
      result: { recovered: true },
    });
    const recoveredRecords = await recoveredRuntime.recordsAfter("run-1", 0);
    expect(recoveredRecords.filter((record) =>
      record.eventType === "effect.completed" && record.payload.effectId === "recover-generic-effect-1"
    )).toHaveLength(1);
    expect(recoveredRecords.find((record) =>
      record.eventType === "command.accepted" &&
      record.causationId === request.commandId &&
      (record.payload.command as { payload?: { type?: string } } | undefined)?.payload?.type === "effectResultSupplied"
    )?.payload.command).toMatchObject({
      source: {
        kind: "providerSdk",
        provider: "codex",
        nativeSessionId: "resumed-native-session",
      },
    });
  });

  it("continues effect processing when post-commit registry publication fails", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-effect-registry-");
    const registry = new FailNextRunRegistry(root);
    let executions = 0;
    const scenario = createTestScenarioRuntime({
      root,
      registry,
      effectExecutor: {
        async execute() {
          executions += 1;
          return { result: { completed: true } };
        },
      },
    });
    await start(scenario);
    registry.arm();
    const request = command("run-1", "registry-effect", {
      type: "requestEffect",
      effectId: "registry-effect-1",
      effectType: "fixture",
      parameters: {},
    });
    await expect(scenario.dispatch(request)).resolves.toEqual({ status: "accepted" });
    await expect(scenario.dispatch(request)).resolves.toEqual({ status: "accepted" });
    expect(executions).toBe(1);
    const snapshot = await scenario.snapshot("run-1");
    expect(snapshot.effects[0]).toMatchObject({ status: "completed" });
    expect(snapshot.recoveryDiagnostics).toContain(
      "Run registry publication failed: simulated registry outage",
    );
  });

  it("reconstructs a pending rule-pipeline effect after restart", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-rule-retry-");
    const crashStore = new CrashAfterCommitStore(root);
    const crashedRuntime = createTestScenarioRuntime({ root, store: crashStore });
    await start(crashedRuntime);
    const input = { command: "rm protected.txt" };
    const request = command("run-1", "recover-rule-effect", {
      type: "toolRequested",
      toolCallId: "recover-rule-tool",
      turnId: "recover-rule-turn",
      name: "Bash",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: false,
    });
    crashStore.arm();
    await expect(crashedRuntime.dispatch(request)).rejects.toThrow("simulated process exit after commit");

    let checks = 0;
    const recoveredRuntime = createTestScenarioRuntime({
      root,
      effectExecutor: new RulePipelineEffectExecutor({
        rules: [{
          name: "recovered-deny",
          displayName: "Recovered deny",
          priority: 1,
          appealable: false,
          usesLlm: false,
          promptSection: "",
          async check() {
            checks += 1;
            return { fastDeny: "recovered rule denied" };
          },
        }],
      }),
    });
    await expect(recoveredRuntime.dispatch(request)).resolves.toEqual({
      status: "denied",
      reason: "recovered rule denied",
    });
    expect(checks).toBe(1);
    const snapshot = await recoveredRuntime.snapshot("run-1");
    expect(snapshot.effects[0]).toMatchObject({ status: "completed" });
    expect(agentFrameworkRulePipelineState(snapshot).evaluations.at(-1))
      .toMatchObject({ status: "completed", result: "fastDeny" });
    expect(snapshot.toolCalls[0].authorization.final).toBe("denied");
  });

  it("does not reclaim an actively renewed effect claim", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-effect-reclaim-");
    let now = Date.parse("2026-07-15T12:00:00.000Z");
    let entered!: () => void;
    let release!: () => void;
    const effectEntered = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const firstRuntime = createTestScenarioRuntime({
      root,
      clock: () => new Date(now),
      effectClaimLeaseMs: 50,
      effectClaimHeartbeatMs: 5,
      effectExecutor: {
        async execute() {
          entered();
          await barrier;
          return { result: { worker: "stale" } };
        },
      },
    });
    await start(firstRuntime);
    const request = command("run-1", "reclaim-effect", {
      type: "requestEffect",
      effectId: "reclaim-effect-1",
      effectType: "fixture",
      parameters: {},
    });
    const firstDispatch = firstRuntime.dispatch(request);
    await effectEntered;
    const originalClaim = (await firstRuntime.snapshot("run-1")).effects[0].claimId;
    now += 60_000;
    await waitForCondition(async () =>
      (await firstRuntime.snapshot("run-1")).effects[0].claimRenewedAt === "2026-07-15T12:01:00.000Z"
    );

    let recoveryExecutions = 0;
    const recoveredRuntime = createTestScenarioRuntime({
      root,
      clock: () => new Date(now),
      effectClaimLeaseMs: 50,
      effectClaimHeartbeatMs: 5,
      effectExecutor: {
        async execute() {
          recoveryExecutions += 1;
          return { result: { worker: "recovered" } };
        },
      },
    });
    await recoveredRuntime.recoverPendingEffects("run-1");
    expect(recoveryExecutions).toBe(0);
    expect((await recoveredRuntime.snapshot("run-1")).effects[0].claimId).toBe(originalClaim);

    release();
    await expect(firstDispatch).resolves.toEqual({ status: "accepted" });
    expect((await recoveredRuntime.recordsAfter("run-1", 0)).filter((record) =>
      record.eventType === "effect.completed" && record.payload.effectId === "reclaim-effect-1"
    )).toHaveLength(1);
  });

  it("starts each queued effect before draining the next effect", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-effect-drain-order-");
    const executionOrder: string[] = [];
    const runtime = new ScenarioRuntime({
      root,
      effectExecutor: {
        async execute(request) {
          executionOrder.push(request.effectId);
          return { result: { completed: request.effectId } };
        },
      },
    });
    await start(runtime);
    for (const effectId of ["queued-effect-a", "queued-effect-b"]) {
      await runtime.replayCommand(command("run-1", `request-${effectId}`, {
        type: "requestEffect",
        effectId,
        effectType: "fixture",
        parameters: {},
      }));
    }

    await runtime.recoverPendingEffects("run-1");

    expect(executionOrder).toEqual(["queued-effect-a", "queued-effect-b"]);
    const records = await runtime.recordsAfter("run-1", 0);
    const started = records.filter((record) => record.eventType === "effect.started");
    expect(started.map((record) => record.payload.effectId))
      .toEqual(["queued-effect-a", "queued-effect-b"]);
    expect((await runtime.snapshot("run-1")).effects.map((effect) => effect.status))
      .toEqual(["completed", "completed"]);
  });

  it("rejects a recovery claim when the owner renews after the stale eligibility read", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-effect-claim-race-");
    let now = Date.parse("2026-07-15T12:00:00.000Z");
    let markEffectEntered!: () => void;
    let releaseEffect!: () => void;
    const effectEntered = new Promise<void>((resolve) => { markEffectEntered = resolve; });
    const effectBarrier = new Promise<void>((resolve) => { releaseEffect = resolve; });
    const ownerRuntime = createTestScenarioRuntime({
      root,
      clock: () => new Date(now),
      effectClaimLeaseMs: 60_000,
      effectClaimHeartbeatMs: 59_999,
      effectExecutor: {
        async execute() {
          markEffectEntered();
          await effectBarrier;
          return { result: { worker: "owner" } };
        },
      },
    });
    await start(ownerRuntime);
    const ownerDispatch = ownerRuntime.dispatch(command("run-1", "claim-race-effect", {
      type: "requestEffect",
      effectId: "claim-race-effect",
      effectType: "fixture",
      parameters: {},
    }));
    await effectEntered;
    const ownerClaim = (await ownerRuntime.snapshot("run-1")).effects[0].claimId;
    expect(ownerClaim).not.toBeNull();
    now += 120_000;

    let markReplacementAttempted!: () => void;
    let releaseReplacement!: () => void;
    const replacementAttempted = new Promise<void>((resolve) => { markReplacementAttempted = resolve; });
    const replacementBarrier = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    let recoveryExecutions = 0;
    class PausedRecoveryRuntime extends ScenarioRuntime {
      public override async replayCommand(input: ScenarioCommand) {
        if (input.payload.type === "effectStarted" && input.payload.previousClaimId) {
          markReplacementAttempted();
          await replacementBarrier;
        }
        return super.replayCommand(input);
      }
    }
    const recoveryRuntime = new PausedRecoveryRuntime({
      root,
      clock: () => new Date(now),
      effectClaimLeaseMs: 60_000,
      effectExecutor: {
        async execute() {
          recoveryExecutions += 1;
          return { result: { worker: "recovery" } };
        },
      },
    });
    const recovery = recoveryRuntime.recoverPendingEffects("run-1");
    await replacementAttempted;
    await ownerRuntime.dispatch(command("run-1", "claim-race-renewal", {
      type: "effectClaimRenewed",
      effectId: "claim-race-effect",
      effectType: "fixture",
      claimId: ownerClaim!,
    }, new Date(now).toISOString()));
    releaseReplacement();
    await recovery;

    expect(recoveryExecutions).toBe(0);
    expect((await recoveryRuntime.snapshot("run-1")).effects[0]).toMatchObject({
      status: "started",
      claimId: ownerClaim,
      claimRenewedAt: new Date(now).toISOString(),
    });
    releaseEffect();
    await expect(ownerDispatch).resolves.toEqual({ status: "accepted" });
  });

  it("retries an eligible policy effect after an unrelated snapshot revision commits", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-effect-revision-race-");
    let markClaimAttempted!: () => void;
    let releaseClaim!: () => void;
    const claimAttempted = new Promise<void>((resolve) => { markClaimAttempted = resolve; });
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve; });
    let pauseClaim = true;
    class PausedPolicyClaimRuntime extends ScenarioRuntime {
      public override async replayCommand(input: ScenarioCommand) {
        if (pauseClaim && input.payload.type === "effectStarted") {
          pauseClaim = false;
          markClaimAttempted();
          await claimBarrier;
        }
        return super.replayCommand(input);
      }
    }
    let executions = 0;
    const scenario = new PausedPolicyClaimRuntime({
      root,
      effectPlanner: agentFrameworkEffectPlanner,
      effectExecutor: new RulePipelineEffectExecutor({
        rules: [{
          name: "revision-race-deny",
          displayName: "Revision race deny",
          priority: 1,
          appealable: false,
          usesLlm: false,
          promptSection: "",
          async check() {
            executions += 1;
            return { fastDeny: "revision race denied" };
          },
        }],
      }),
    });
    await start(scenario);
    const input = { command: "cat private.txt" };
    const policy = scenario.dispatch(command("run-1", "revision-race-policy", {
      type: "toolRequested",
      toolCallId: "revision-race-tool",
      turnId: "revision-race-turn",
      name: "Bash",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: false,
    }));
    await claimAttempted;
    await createTestScenarioRuntime({ root }).recordDiagnostic(
      "run-1",
      "unrelated concurrent diagnostic",
      "revisionRaceTest",
    );
    releaseClaim();

    await expect(policy).resolves.toEqual({ status: "denied", reason: "revision race denied" });
    expect(executions).toBe(1);
    expect((await scenario.snapshot("run-1")).effects).toMatchObject([{ status: "completed" }]);
  });

  it("rejects active claim replacement and aborts local execution after expired ownership is lost", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-effect-fencing-");
    let entered!: () => void;
    const effectEntered = new Promise<void>((resolve) => { entered = resolve; });
    let observedAbort = false;
    const firstRuntime = createTestScenarioRuntime({
      root,
      clock: () => new Date("2026-07-15T12:00:00.000Z"),
      effectClaimLeaseMs: 1_000,
      effectClaimHeartbeatMs: 5,
      effectExecutor: {
        async execute(request) {
          entered();
          await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          }, { once: true }));
          return { result: { worker: "lost-owner" } };
        },
      },
    });
    await start(firstRuntime);
    const request = command("run-1", "fenced-effect-command", {
      type: "requestEffect",
      effectId: "fenced-effect",
      effectType: "fixture",
      parameters: {},
    });
    const firstDispatch = firstRuntime.dispatch(request);
    await effectEntered;
    const originalClaim = (await firstRuntime.snapshot("run-1")).effects[0].claimId;
    const activeReplacementRuntime = createTestScenarioRuntime({
      root,
      clock: () => new Date("2026-07-15T12:00:00.000Z"),
    });
    const replacementPayload = {
      type: "effectStarted",
      effectId: "fenced-effect",
      effectType: "fixture",
      claimId: "replacement-claim",
      ...(originalClaim === null ? {} : { previousClaimId: originalClaim }),
    } as const;
    await expect(activeReplacementRuntime.dispatch(command(
      "run-1",
      "active-replacement-effect-claim",
      replacementPayload,
    ))).rejects.toThrow("Effect claim lease is still active: fenced-effect");
    const replacementRuntime = createTestScenarioRuntime({
      root,
      clock: () => new Date("2026-07-15T12:01:00.000Z"),
    });
    await replacementRuntime.dispatch(command(
      "run-1",
      "expired-replacement-effect-claim",
      replacementPayload,
      "2026-07-15T12:01:00.000Z",
    ));

    await expect(firstDispatch).resolves.toEqual({ status: "cancelled", reason: "Effect cancelled" });
    expect(observedAbort).toBe(true);
    expect((await replacementRuntime.snapshot("run-1")).effects[0]).toMatchObject({
      status: "started",
      claimId: "replacement-claim",
    });
  });

  it("reclaims an expired claim after its worker stops renewing", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-expired-claim-");
    const store = new RunStore(root);
    const initialRuntime = createTestScenarioRuntime({ root, store });
    await start(initialRuntime);
    await store.transact("run-1", async (run) => ({
      records: [
        {
          runId: "run-1",
          recordSeq: run.snapshot.lastRecordSeq + 1,
          recordId: "expired-effect-requested",
          recordedAt: "2026-07-15T12:00:00.000Z",
          commandId: "expired-effect-command",
          eventType: "effect.requested" as const,
          visibility: "public" as const,
          payload: { effectId: "expired-effect", effectType: "fixture", parameters: {} },
        },
        {
          runId: "run-1",
          recordSeq: run.snapshot.lastRecordSeq + 2,
          recordId: "expired-effect-started",
          recordedAt: "2026-07-15T12:00:00.000Z",
          commandId: "expired-effect-claim",
          eventType: "effect.started" as const,
          visibility: "localSensitive" as const,
          payload: { effectId: "expired-effect", effectType: "fixture", claimId: "expired-claim" },
        },
      ] as ScenarioRecord[],
      value: null,
    }));
    let recoveryExecutions = 0;
    const recoveredRuntime = createTestScenarioRuntime({
      root,
      clock: () => new Date("2026-07-15T12:01:00.000Z"),
      effectClaimLeaseMs: 50,
      effectClaimHeartbeatMs: 5,
      effectExecutor: {
        async execute(request) {
          recoveryExecutions += 1;
          expect(request.fencingToken).toBeTruthy();
          expect(request.fencingToken).not.toBe("expired-claim");
          return { result: { worker: "recovered" } };
        },
      },
    });

    await recoveredRuntime.recoverPendingEffects("run-1");

    expect(recoveryExecutions).toBe(1);
    expect((await recoveredRuntime.snapshot("run-1")).effects[0]).toMatchObject({
      status: "completed",
      result: { worker: "recovered" },
    });
  });

  it("cancels a blocked rule effect without releasing its completion barrier", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-cancel-effect-");
    let entered!: () => void;
    const effectEntered = new Promise<void>((resolve) => { entered = resolve; });
    let normalCompletion = false;
    const blockingRule: PreToolRule = {
      name: "blocking-rule",
      displayName: "Blocking rule",
      priority: 1,
      appealable: false,
      usesLlm: false,
      promptSection: "",
      async check(context) {
        entered();
        await new Promise<void>((resolve, reject) => {
          const finishNormally = () => {
            normalCompletion = true;
            resolve();
          };
          void finishNormally;
          const abort = () => reject(new DOMException("Effect cancelled", "AbortError"));
          if (context.signal?.aborted) abort();
          else context.signal?.addEventListener("abort", abort, { once: true });
        });
        return null;
      },
    };
    const scenario = createTestScenarioRuntime({
      root,
      effectExecutor: new RulePipelineEffectExecutor({ rules: [blockingRule] }),
    });
    await start(scenario);
    const input = { command: "pwd" };
    const dispatch = scenario.dispatch(command("run-1", "blocked-policy", {
      type: "toolRequested",
      toolCallId: "blocked-tool",
      turnId: "blocked-turn",
      name: "Bash",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: false,
    }));
    await effectEntered;

    scenario.cancelActiveEffects("run-1", "Turn cancelled");
    await expect(dispatch).resolves.toMatchObject({ status: "cancelled" });

    expect(normalCompletion).toBe(false);
    expect((await scenario.snapshot("run-1")).effects[0]).toMatchObject({ status: "cancelled" });
    expect((await scenario.recordsAfter("run-1", 0)).some((record) =>
      record.eventType === "effect.cancelled" && record.payload.reason === "Turn cancelled"
    )).toBe(true);
  });

  it("atomically cancels and aborts an executing effect on a fatal runtime error", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-fatal-effect-");
    let entered!: () => void;
    const effectEntered = new Promise<void>((resolve) => { entered = resolve; });
    let aborted = false;
    const scenario = createTestScenarioRuntime({
      root,
      effectExecutor: new RulePipelineEffectExecutor({ rules: [{
        name: "fatal-blocking-rule", displayName: "Fatal blocking rule", priority: 1,
        appealable: false, usesLlm: false, promptSection: "",
        async check(context) {
          entered();
          await new Promise<void>((_resolve, reject) => {
            const abort = () => { aborted = true; reject(new DOMException("Run failed", "AbortError")); };
            if (context.signal?.aborted) abort();
            else context.signal?.addEventListener("abort", abort, { once: true });
          });
          return null;
        },
      }] }),
    });
    await start(scenario);
    const input = { command: "pwd" };
    const pending = scenario.dispatch(command("run-1", "fatal-policy", {
      type: "toolRequested", toolCallId: "fatal-tool", turnId: null, name: "Bash", input,
      inputDigest: digestScenarioValue(input), requiresUserDecision: false,
    }));
    await effectEntered;
    await expect(scenario.dispatch(command("run-1", "fatal-error", {
      type: "runtimeErrorObserved",
      data: { code: "provider_failed", message: "fatal", recoverable: false },
    }))).resolves.toMatchObject({ status: "failed" });
    await pending;
    const snapshot = await scenario.snapshot("run-1");
    expect(aborted).toBe(true);
    expect(snapshot.status).toBe("failed");
    expect(snapshot.effects[0]?.status).toBe("cancelled");
  });

  it("projects tool names from canonical tool records when the accepted command is artifact-backed", () => {
    const recordedAt = "2026-07-15T12:00:00.000Z";
    const records: ScenarioRecord[] = [{
      runId: "statusline-artifact-run",
      recordSeq: 1,
      recordId: "accepted-artifact",
      recordedAt,
      commandId: "artifact-command",
      eventType: "command.accepted",
      visibility: "public",
      payload: { command: "[scenario-artifact-value]", result: { status: "accepted" } },
    }, {
      runId: "statusline-artifact-run",
      recordSeq: 2,
      recordId: "requested-artifact-tool",
      recordedAt,
      commandId: "artifact-command",
      eventType: "tool.requested",
      visibility: "public",
      payload: { name: "Write" },
    }, {
      runId: "statusline-artifact-run",
      recordSeq: 3,
      recordId: "artifact-rule-completed",
      recordedAt,
      commandId: "artifact-command",
      eventType: "extension.observed",
      visibility: "localSensitive",
      payload: {
        extensionId: AGENT_FRAMEWORK_RULE_EXTENSION_ID,
        event: "rule.evaluation.completed",
        evaluation: {
          ruleId: "agent-framework.rule.artifact",
          commandId: "artifact-command",
          status: "completed",
          result: "allow",
        },
      },
    }];

    expect(canonicalRuleStatusLineEntries(records)).toMatchObject([{
      agent: "agent-framework.rule.artifact",
      toolName: "Write",
      status: "completed",
    }]);
  });

  it("keeps a newer running evaluation visible beside an older completion for the same rule and tool", () => {
    const visible = filterRuleStatusLineEntries([{
      evaluationId: "new-evaluation",
      agent: "agent-framework.rule.repeated",
      decision: "APPROVE",
      toolName: "Bash",
      timestamp: 2_000,
      status: "running",
    }, {
      evaluationId: "old-evaluation",
      agent: "agent-framework.rule.repeated",
      decision: "APPROVE",
      toolName: "Bash",
      timestamp: 1_000,
      status: "completed",
    }], 3_000, 5_000);

    expect(visible).toMatchObject([
      { evaluationId: "new-evaluation", status: "running" },
      { evaluationId: "old-evaluation", status: "completed" },
    ]);
  });

  it("shows a blocked rule as running and replaces it with completed after release", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-statusline-progress-");
    let entered!: () => void;
    let release!: () => void;
    const effectEntered = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const blockingRule: PreToolRule = {
      name: "statusline-blocking-rule",
      displayName: "Statusline blocking rule",
      priority: 1,
      appealable: false,
      usesLlm: false,
      promptSection: "",
      async check() {
        entered();
        await barrier;
        return null;
      },
    };
    const scenario = createTestScenarioRuntime({
      root,
      effectExecutor: new RulePipelineEffectExecutor({ rules: [blockingRule] }),
    });
    await start(scenario);
    const input = { command: "pwd" };
    const dispatch = scenario.dispatch(command("run-1", "statusline-policy", {
      type: "toolRequested",
      toolCallId: "statusline-tool",
      turnId: "statusline-turn",
      name: "Bash",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: false,
    }));
    await effectEntered;

    const whileBlocked = filterRuleStatusLineEntries(
      canonicalRuleStatusLineEntries(await scenario.recordsAfter("run-1", 0)),
      Date.parse("2026-07-15T12:00:00.000Z"),
    );
    expect(whileBlocked).toMatchObject([{
      agent: "agent-framework.rule.statusline-blocking-rule",
      status: "running",
      toolName: "Bash",
    }]);

    release();
    await expect(dispatch).resolves.toMatchObject({ status: "allowed" });
    const afterRelease = filterRuleStatusLineEntries(
      canonicalRuleStatusLineEntries(await scenario.recordsAfter("run-1", 0)),
      Date.parse("2026-07-15T12:00:00.000Z"),
    );
    expect(afterRelease).toMatchObject([{
      agent: "agent-framework.rule.statusline-blocking-rule",
      status: "completed",
      toolName: "Bash",
    }]);
    expect(afterRelease.some((entry) => entry.status === "running")).toBe(false);
  });

  it("projects common rule-effect observability identically for tool and hook effects", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-rule-projection-");
    const shared = {
      rules: [{
        ruleId: "agent-framework.rule.shared",
        name: "shared",
        displayName: "Shared",
        priority: 1,
        supportedHookEvents: ["PreToolUse", "UserPromptSubmit"],
        appealable: false,
        usesLlm: false,
        version: "1",
        configuration: {},
      }],
      evaluations: [{
        evaluationId: "shared-evaluation",
        ruleId: "agent-framework.rule.shared",
        commandId: "shared-command",
        status: "completed" as const,
        result: "noMatch",
        reason: null,
        context: null,
        elapsedMs: 1,
        error: null,
      }],
      stages: [{
        eventType: "rule.gate.requested" as const,
        ruleId: "agent-framework.rule.shared",
        payload: { phase: "shared" },
      }],
      stateChanges: [{
        key: "projection.shared",
        schemaId: "agent-framework://state/projection-shared",
        status: "validated" as const,
        source: "test",
        visibility: "localSensitive" as const,
        value: { projected: true },
        diagnostics: [],
      }],
    };
    const scenario = createTestScenarioRuntime({
      root,
      effectExecutor: {
        async execute(request) {
          if (request.effectType === "rulePipeline.evaluate") {
            const result = {
              kind: "toolPolicyEvaluation" as const,
              toolCallId: "projection-tool",
              requiresUserDecision: false,
              decision: "allow" as const,
              reason: null,
              agent: "shared",
              gateNote: null,
              ...shared,
            };
            const execution = request.executionContext as { snapshot?: unknown };
            return {
              result,
              projection: projectToolPolicyEffect(
                result,
                scenarioSnapshotSchema.parse(execution.snapshot),
              ),
            };
          }
          const result = {
            kind: "hookRuleEvaluation" as const,
            event: "UserPromptSubmit" as const,
            decision: "allow" as const,
            reason: null,
            contextMessage: null,
            ...shared,
          };
          const execution = request.executionContext as { snapshot?: unknown };
          return {
            result,
            projection: projectHookRuleEffect(result, scenarioSnapshotSchema.parse(execution.snapshot)),
          };
        },
      },
    });
    await start(scenario, "tool-projection-run");
    await start(scenario, "hook-projection-run");
    const input = { command: "pwd" };
    await scenario.dispatch(command("tool-projection-run", "tool-projection-command", {
      type: "toolRequested",
      toolCallId: "projection-tool",
      turnId: null,
      name: "Bash",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: false,
    }));
    await scenario.dispatch(command("hook-projection-run", "hook-projection-command", agentFrameworkHostCommand({
      type: "hostUserPromptSubmitted",
      workflow: {},
      context: {},
      messageId: "projection-message",
      prompt: "project",
      contentDigest: digestScenarioValue("project"),
    })));
    const projected = async (runId: string) => (await scenario.recordsAfter(runId, 0))
      .filter((record) =>
        (record.eventType === "extension.observed" &&
          record.payload.extensionId === AGENT_FRAMEWORK_RULE_EXTENSION_ID &&
          ["rule.evaluation.completed", "rule.gate.requested"].includes(
            String(record.payload.event),
          )) ||
        (record.eventType === "state.sliceChanged" &&
          [AGENT_FRAMEWORK_RULE_PIPELINE_STATE_KEY, "projection.shared"].includes(
            (record.payload.slice as { key?: string } | undefined)?.key ?? "",
          ))
      )
      .map(({ eventType, entityRef, payload }) => {
        if (eventType !== "state.sliceChanged") return { eventType, entityRef, payload };
        const slice = payload.slice as Record<string, unknown>;
        const { updatedAt: _updatedAt, ...stableSlice } = slice;
        return { eventType, entityRef, payload: { slice: stableSlice } };
      });

    expect(await projected("hook-projection-run")).toEqual(await projected("tool-projection-run"));
  });

  it("applies repeated effect projections for one state slice sequentially", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-sequential-projection-");
    const stateKey = "projection.sequential";
    const scenario = createTestScenarioRuntime({
      root,
      stateSlicePolicy: {
        initialChanges: () => [],
        merge({ key, incomingValue, currentValue }) {
          if (key !== stateKey) return incomingValue;
          return [
            ...(Array.isArray(currentValue) ? currentValue : []),
            ...(Array.isArray(incomingValue) ? incomingValue : []),
          ];
        },
      },
      effectExecutor: createDeterministicPolicyExecutor({
        transformToolResult(result) {
          return {
            ...result,
            stateChanges: [
              {
                key: stateKey,
                schemaId: "agent-framework://state/projection-sequential",
                status: "validated",
                source: "test.first",
                visibility: "localSensitive",
                baseValue: [],
                value: ["first"],
                diagnostics: [],
              },
              {
                key: stateKey,
                schemaId: "agent-framework://state/projection-sequential",
                status: "validated",
                source: "test.second",
                visibility: "localSensitive",
                baseValue: [],
                value: ["second"],
                diagnostics: [],
              },
            ],
          };
        },
      }),
    });
    await start(scenario);
    const input = { command: "pwd" };

    await scenario.dispatch(command("run-1", "sequential-projection-command", {
      type: "toolRequested",
      toolCallId: "sequential-projection-tool",
      turnId: null,
      name: "Bash",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: false,
    }));

    const slices = (await scenario.recordsAfter("run-1", 0))
      .filter((record) =>
        record.eventType === "state.sliceChanged" &&
        (record.payload.slice as { key?: string } | undefined)?.key === stateKey
      )
      .map((record) => record.payload.slice as { revision: number; value: unknown });
    expect(slices).toEqual([
      expect.objectContaining({ revision: 1, value: ["first"] }),
      expect.objectContaining({ revision: 2, value: ["first", "second"] }),
    ]);
    expect((await scenario.snapshot("run-1")).stateSlices[stateKey]).toMatchObject({
      revision: 2,
      value: ["first", "second"],
    });
  });

  it("validates and persists append-only feedback supersession", async () => {
    const context = await runtime();
    await start(context.runtime);
    const content = "Done";
    await context.runtime.dispatch(command("run-1", "assistant", {
      type: "assistantMessageCompleted",
      messageId: "message-1",
      turnId: "turn-1",
      content,
      contentDigest: digestScenarioValue(content),
    }));
    const baseFeedback = {
      type: "submitFeedback" as const,
      targetKind: "assistantMessage" as const,
      targetId: "message-1",
      note: "  Helpful  ",
      expectedTargetDigest: digestScenarioValue(content),
      author: { subjectId: "local-user", clientId: "test", clientVersion: "1" },
    };
    await context.runtime.dispatch(command("run-1", "feedback-1", {
      ...baseFeedback,
      vote: "up",
      idempotencyKey: "feedback-key-1",
    }));
    await context.runtime.dispatch(command("run-1", "feedback-2", {
      ...baseFeedback,
      vote: "down",
      note: "Missed a constraint",
      idempotencyKey: "feedback-key-2",
    }));

    const entries = await readFeedbackEntries(runFeedbackPath("run-1", context.root));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ vote: "up", note: "Helpful", supersedesFeedbackId: null });
    expect(entries[1]).toMatchObject({ vote: "down", supersedesFeedbackId: entries[0].feedbackId });
    expect(Object.values((await context.runtime.snapshot("run-1")).feedback)[0].vote).toBe("down");
  });

  it("binds tool feedback to the completed result rather than the request input", async () => {
    const context = await runtime();
    await start(context.runtime);
    const input = { path: "README.md" };
    await context.runtime.dispatch(command("run-1", "tool-request", {
      type: "toolRequested",
      toolCallId: "tool-1",
      turnId: "turn-1",
      name: "Read",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: false,
    }));
    const requested = (await context.runtime.snapshot("run-1")).toolCalls[0];
    await context.runtime.dispatch(command("run-1", "tool-start", {
      type: "toolExecutionStarted",
      toolCallId: "tool-1",
    }));
    await context.runtime.dispatch(command("run-1", "tool-complete", {
      type: "toolCompleted",
      toolCallId: "tool-1",
      output: { text: "complete output" },
    }));
    const completed = (await context.runtime.snapshot("run-1")).toolCalls[0];
    expect(completed.feedbackDigest).not.toBe(requested.feedbackDigest);
    expect(completed.recordSeq).toBeGreaterThan(requested.recordSeq);

    const feedback = {
      type: "submitFeedback" as const,
      targetKind: "toolCall" as const,
      targetId: "tool-1",
      vote: "up" as const,
      idempotencyKey: "tool-feedback",
      author: { subjectId: "local-user", clientId: "test", clientVersion: "1" },
    };
    await expect(context.runtime.dispatch(command("run-1", "stale-tool-feedback", {
      ...feedback,
      expectedTargetDigest: requested.feedbackDigest,
      targetRecordSeq: requested.recordSeq,
    }))).rejects.toThrow("Feedback target digest is stale");
    await expect(context.runtime.dispatch(command("run-1", "current-tool-feedback", {
      ...feedback,
      idempotencyKey: "tool-feedback-current",
      expectedTargetDigest: completed.feedbackDigest,
      targetRecordSeq: completed.recordSeq,
    }))).resolves.toMatchObject({ status: "accepted" });
  });

  it("advances assistant feedback cursors from streaming observation to completion", async () => {
    const context = await runtime();
    await start(context.runtime);
    await context.runtime.dispatch(command("run-1", "assistant-stream", {
      type: "assistantMessageObserved", messageId: "assistant-cursor", turnId: "turn-1",
      content: "partial", contentDigest: digestScenarioValue("partial"),
    }));
    const streaming = (await context.runtime.snapshot("run-1")).conversation.at(-1)!;
    await context.runtime.dispatch(command("run-1", "assistant-complete", {
      type: "assistantMessageCompleted", messageId: "assistant-cursor", turnId: "turn-1",
      content: "complete", contentDigest: digestScenarioValue("complete"),
    }));
    const completed = (await context.runtime.snapshot("run-1")).conversation.at(-1)!;
    expect(completed.recordSeq).toBeGreaterThan(streaming.recordSeq);
    await expect(context.runtime.dispatch(command("run-1", "stale-assistant-feedback", {
      type: "submitFeedback", targetKind: "assistantMessage", targetId: "assistant-cursor",
      vote: "up", idempotencyKey: "stale-assistant", targetRecordSeq: streaming.recordSeq,
      author: { subjectId: "local-user", clientId: "test", clientVersion: "1" },
    }))).rejects.toThrow("Feedback target record sequence is stale");
  });

  it("rejects invalid tool lifecycle transitions without journal mutation", async () => {
    const context = await runtime();
    await start(context.runtime);
    const input = { command: "true" };
    await context.runtime.dispatch(command("run-1", "tool-request-transition", {
      type: "toolRequested",
      toolCallId: "transition-tool",
      turnId: "transition-turn",
      name: "Bash",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: false,
    }));

    const rejectWithoutMutation = async (candidate: ScenarioCommand, message: string) => {
      const snapshot = await context.runtime.snapshot("run-1");
      const records = await context.runtime.recordsAfter("run-1", 0);
      await expect(context.runtime.dispatch(candidate)).rejects.toThrow(message);
      expect(await context.runtime.snapshot("run-1")).toEqual(snapshot);
      expect(await context.runtime.recordsAfter("run-1", 0)).toEqual(records);
    };

    await rejectWithoutMutation(command("run-1", "output-before-start", {
      type: "toolOutputAppended",
      toolCallId: "transition-tool",
      output: "too early",
    }), "requires a running tool call");
    await context.runtime.dispatch(command("run-1", "tool-start-transition", {
      type: "toolExecutionStarted",
      toolCallId: "transition-tool",
    }));
    await context.runtime.dispatch(command("run-1", "tool-complete-transition", {
      type: "toolCompleted",
      toolCallId: "transition-tool",
      output: "done",
    }));
    for (const [commandId, payload] of [
      ["restart-terminal-tool", { type: "toolExecutionStarted", toolCallId: "transition-tool" }],
      ["output-terminal-tool", { type: "toolOutputAppended", toolCallId: "transition-tool", output: "late" }],
      ["fail-terminal-tool", { type: "toolFailed", toolCallId: "transition-tool", error: "late" }],
    ] as const) {
      await rejectWithoutMutation(command("run-1", commandId, payload), "already terminal");
    }
  });

  it("rejects message identity collisions and terminal regressions without mutation", async () => {
    const context = await runtime();
    await start(context.runtime);
    await context.runtime.dispatch(command("run-1", "identity-user", {
      type: "userMessageSubmitted",
      messageId: "identity-message",
      turnId: "identity-turn",
      content: "user content",
      contentDigest: digestScenarioValue("user content"),
    }));
    await context.runtime.dispatch(command("run-1", "terminal-assistant-stream", {
      type: "assistantMessageObserved",
      messageId: "terminal-assistant",
      turnId: "assistant-turn",
      content: "partial",
      contentDigest: digestScenarioValue("partial"),
    }));
    await context.runtime.dispatch(command("run-1", "terminal-assistant-complete", {
      type: "assistantMessageCompleted",
      messageId: "terminal-assistant",
      turnId: "assistant-turn",
      content: "complete",
      contentDigest: digestScenarioValue("complete"),
    }));
    const before = {
      snapshot: await context.runtime.snapshot("run-1"),
      records: await context.runtime.recordsAfter("run-1", 0),
    };
    const invalid: Array<[string, ScenarioCommand["payload"], string]> = [
      ["duplicate-user", {
        type: "userMessageSubmitted", messageId: "identity-message", turnId: "identity-turn",
        content: "user content", contentDigest: digestScenarioValue("user content"),
      }, "already committed"],
      ["role-collision", {
        type: "assistantMessageObserved", messageId: "identity-message", turnId: "identity-turn",
        content: "assistant collision", contentDigest: digestScenarioValue("assistant collision"),
      }, "identity changed"],
      ["turn-collision", {
        type: "assistantMessageObserved", messageId: "terminal-assistant", turnId: "different-turn",
        content: "late", contentDigest: digestScenarioValue("late"),
      }, "identity changed"],
      ["terminal-regression", {
        type: "assistantMessageObserved", messageId: "terminal-assistant", turnId: "assistant-turn",
        content: "late", contentDigest: digestScenarioValue("late"),
      }, "already terminal"],
      ["native-role-collision", {
        type: "nativeTranscriptObserved",
        data: { messages: [{
          id: "identity-message", turnId: "identity-turn", role: "assistant",
          content: "native collision", contentDigest: digestScenarioValue("native collision"), status: "streaming",
        }], tools: [] },
      }, "Native transcript message identity changed"],
      ["native-terminal-regression", {
        type: "nativeTranscriptObserved",
        data: { messages: [{
          id: "terminal-assistant", turnId: "assistant-turn", role: "assistant",
          content: "late", contentDigest: digestScenarioValue("late"), status: "streaming",
        }], tools: [] },
      }, "Native transcript terminal message changed"],
    ];
    for (const [commandId, payload, message] of invalid) {
      await expect(context.runtime.dispatch(command("run-1", commandId, payload))).rejects.toThrow(message);
      expect(await context.runtime.snapshot("run-1")).toEqual(before.snapshot);
      expect(await context.runtime.recordsAfter("run-1", 0)).toEqual(before.records);
    }
  });

  it("rejects ambiguous native claims over indistinguishable host-owned tools", async () => {
    const context = await runtime();
    await start(context.runtime);
    const input = { file_path: "README.md" };
    for (const toolCallId of ["ambiguous-host-1", "ambiguous-host-2"]) {
      await context.runtime.dispatch(command("run-1", `${toolCallId}-observed`, {
        type: "toolExecutionObserved",
        toolCallId,
        turnId: null,
        name: "Read",
        input,
        inputDigest: digestScenarioValue(input),
      }));
      await context.runtime.dispatch(command("run-1", `${toolCallId}-completed`, {
        type: "toolCompleted",
        toolCallId,
      }));
    }
    const before = await context.runtime.canonicalView("run-1");

    await expect(context.runtime.dispatch(command("run-1", "ambiguous-native-observation", {
      type: "nativeTranscriptObserved",
      data: {
        messages: [],
        tools: [{
          id: "native-ambiguous-tool",
          turnId: "native-turn",
          name: "Read",
          input,
          inputDigest: digestScenarioValue(input),
          status: "completed",
          output: [],
          error: null,
        }],
      },
    }))).rejects.toThrow("Native transcript tool identity is ambiguous");
    expect(await context.runtime.canonicalView("run-1")).toEqual(before);
  });

  it("rejects stale feedback and snapshot revisions", async () => {
    const context = await runtime();
    await start(context.runtime);
    await expect(context.runtime.dispatch({
      ...command("run-1", "stale-command", { type: "resumeRun" }),
      expectedSnapshotRevision: 0,
    })).rejects.toThrow("Snapshot revision conflict");
    await expect(context.runtime.dispatch(command("run-1", "unguarded-feedback", {
      type: "submitFeedback",
      targetKind: "assistantMessage",
      targetId: "message-1",
      vote: "down",
      idempotencyKey: "unguarded",
      author: { subjectId: "local-user", clientId: "test", clientVersion: "1" },
    }))).rejects.toThrow("feedback requires expectedTargetDigest or targetRecordSeq");
    await expect(context.runtime.dispatch(command("run-1", "missing-feedback", {
      type: "submitFeedback",
      targetKind: "toolCall",
      targetId: "missing",
      vote: "down",
      idempotencyKey: "missing",
      targetRecordSeq: 1,
      author: { subjectId: "local-user", clientId: "test", clientVersion: "1" },
    }))).rejects.toThrow("Feedback target does not exist");
  });
});
