import fsModule from "node:fs";
import * as fs from "fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScenarioCommand } from "../../src/scenario/protocol/commands.js";
import {
  materializeScenarioFixture as materializeGenericScenarioFixture,
  runScenarioFixture as runGenericScenarioFixture,
  validateScenarioFixture,
} from "../../src/scenario/fixtures/index.js";
import {
  assertScenarioCommandDigests,
  digestScenarioValue,
} from "../../src/scenario/protocol/digest.js";
import type { JsonValue } from "../../src/scenario/protocol/common.js";
import { scenarioProtocolSchemaDigest } from "../../src/scenario/protocol/schema.js";
import { createTestScenarioRuntime } from "../helpers/scenario-runtime.js";
import {
  createTestStartRunCommandBuilder,
  testScenarioCommand,
} from "../helpers/scenario-fixtures.js";
import {
  cleanupTemporaryTestRoots,
  createTemporaryTestRoot,
} from "../helpers/temporary-root.js";
import { ScenarioEffectCancellationError } from "../../src/scenario/runtime/effects.js";
import { TOOL_POLICY_EFFECT_TYPE } from "../../src/effects/rule-pipeline-contract.js";
import { runSnapshotPath } from "../../src/scenario/store/paths.js";
import { RunStore, type OpenRunResult } from "../../src/scenario/store/run-store.js";
import { RulePipelineEffectExecutor } from "../../src/effects/rule-pipeline-executor.js";
import type { PreToolRule } from "../../src/rules/types.js";
import { predictionBlockRule } from "../../src/rules/prediction-block.js";
import {
  agentFrameworkHostCommand,
  agentFrameworkHostCommandData,
} from "../../src/effects/host-command.js";
import { agentFrameworkScenarioFixturePolicy } from "../../src/effects/scenario-fixture-policy.js";
import {
  AGENT_FRAMEWORK_RULE_EXTENSION_ID,
  agentFrameworkRulePipelineState,
} from "../../src/effects/rule-observability.js";
import {
  AGENT_FRAMEWORK_COMMITTED_BEHAVIOR_SOURCES,
  isAgentFrameworkLiveBehaviorCommand,
} from "../../src/effects/scenario-behavior.js";

const roots: string[] = [];
const materializeScenarioFixture = (
  runtime: Parameters<typeof materializeGenericScenarioFixture>[0],
  runId: string,
  options: NonNullable<Parameters<typeof materializeGenericScenarioFixture>[2]> = {},
) => materializeGenericScenarioFixture(runtime, runId, {
  ...options,
  policy: agentFrameworkScenarioFixturePolicy,
});
const runScenarioFixture = (
  input: unknown,
  options: NonNullable<Parameters<typeof runGenericScenarioFixture>[1]> = {},
) => runGenericScenarioFixture(input, {
  ...options,
  policy: agentFrameworkScenarioFixturePolicy,
});
const startCommand = createTestStartRunCommandBuilder({
  commandId: (runId) => `${runId}-start`,
  source: { kind: "scenarioFixture" },
  recordedAt: "2026-01-01T00:00:00.000Z",
  payload: {
    workingDir: "/fixture",
    projectDir: "/fixture",
    storagePolicy: "ephemeral",
    runtimeHome: { kind: "internal", configuration: { policy: "direct" } },
  },
});

class CommitAfterViewStore extends RunStore {
  public viewOpenCount = 0;
  private commit: (() => Promise<void>) | null = null;
  private committing = false;

  public arm(commit: () => Promise<void>): void {
    this.viewOpenCount = 0;
    this.commit = commit;
  }

  public override async open(runId: string): Promise<OpenRunResult> {
    const opened = await super.open(runId);
    if (!this.committing) this.viewOpenCount += 1;
    const commit = this.commit;
    if (commit && !this.committing) {
      this.commit = null;
      this.committing = true;
      try {
        await commit();
      } finally {
        this.committing = false;
      }
    }
    return opened;
  }
}

afterEach(async () => {
  await cleanupTemporaryTestRoots(roots);
});

describe("ScenarioFixture", () => {
  it("rejects fixtures authored against a stale Scenario protocol digest", () => {
    const start = startCommand("stale-schema");
    if (start.payload.type !== "startRun") throw new Error("test start command is invalid");
    start.payload.schemaDigest = `sha256:${"0".repeat(64)}`;
    const fixture = {
      name: "stale-schema",
      initialRun: { startCommand: start, seedRecords: [] },
      commands: [],
      effects: { mode: "deterministic", outcomes: {}, rejectUnexpected: true },
      expectations: [],
    };
    expect(() => validateScenarioFixture(fixture)).toThrow(
      `must equal the current Scenario protocol digest ${scenarioProtocolSchemaDigest()}`,
    );
  });

  it("runs committed pre-tool and stop fixtures through the canonical runtime", async () => {
    const preTool = JSON.parse(await fs.readFile(new URL(
      "../../scenarios/expected-to-pass/codex-apply-patch-angry-explicit-edit-should-allow.json",
      import.meta.url,
    ), "utf8"));
    const stop = JSON.parse(await fs.readFile(new URL(
      "../../scenarios/expected-to-pass/stop-memory-answer-after-completed-task-should-pass.json",
      import.meta.url,
    ), "utf8"));

    const preToolFixture = validateScenarioFixture(preTool);
    const stopFixture = validateScenarioFixture(stop);
    const executor = new RulePipelineEffectExecutor({
      rules: [{
        name: "committed-fixture-no-match",
        displayName: "Committed fixture no-match rule",
        priority: 1,
        appealable: false,
        usesLlm: false,
        events: ["PreToolUse", "Stop"],
        promptSection: "",
        async check() { return null; },
      }],
    });
    expect((await runScenarioFixture(preToolFixture, { liveEffectExecutor: executor })).pass).toBe(true);
    expect((await runScenarioFixture(stopFixture, { liveEffectExecutor: executor })).pass).toBe(true);
  });

  it("dispatches canonical commands directly and evaluates authored expectations", async () => {
    const start = startCommand("fixture-direct");
    const tool = toolCommand(start.runId, "tool-command", "tool-1");
    const report = await runScenarioFixture({
      name: "direct-tool",
      initialRun: { startCommand: start, seedRecords: [] },
      commands: [tool],
      effects: {
        mode: "deterministic",
        outcomes: {},
        rejectUnexpected: true,
        allowUndeclaredToolPolicy: true,
      },
      expectations: [
        { kind: "commandResult", commandId: tool.commandId, status: "allowed" },
        {
          kind: "record",
          eventType: "tool.authorization.finalResolved",
          entityKind: "toolCall",
          entityId: "tool-1",
          payloadContains: { final: "allowed" },
          count: 1,
        },
        { kind: "snapshot", path: "toolCalls.0.authorization.final", equals: "allowed" },
        { kind: "absentRecord", eventType: "runtime.error" },
      ],
    });

    expect(report.expectationResults.filter((result) => !result.pass)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.finalSnapshot.toolCalls).toHaveLength(1);
  });

  it("preserves fixture execution failure when temporary-root cleanup also fails", async () => {
    const start = startCommand("fixture-primary-cleanup-failure");
    const first = toolCommand(start.runId, "first-tool-command", "duplicate-tool");
    const duplicate = toolCommand(start.runId, "duplicate-tool-command", "duplicate-tool");
    const cleanup = injectFixtureCleanupFailure(new Error("simulated fixture cleanup failure"));

    try {
      await expect(runScenarioFixture({
        name: "fixture-primary-cleanup-failure",
        initialRun: { startCommand: start, seedRecords: [] },
        commands: [first, duplicate],
        effects: {
          mode: "deterministic",
          outcomes: {},
          rejectUnexpected: true,
          allowUndeclaredToolPolicy: true,
        },
        expectations: [],
      })).rejects.toThrow("Tool call already exists: duplicate-tool");
      expect(cleanup.remove).toHaveBeenCalled();
    } finally {
      await cleanup.restore();
    }
  });

  it("reports temporary-root cleanup failure when fixture execution succeeds", async () => {
    const start = startCommand("fixture-cleanup-failure");
    const cleanupFailure = new Error("simulated fixture cleanup failure");
    const cleanup = injectFixtureCleanupFailure(cleanupFailure);

    try {
      await expect(runScenarioFixture({
        name: "fixture-cleanup-failure",
        initialRun: { startCommand: start, seedRecords: [] },
        commands: [],
        effects: { mode: "deterministic", outcomes: {}, rejectUnexpected: true },
        expectations: [],
      })).rejects.toBe(cleanupFailure);
    } finally {
      await cleanup.restore();
    }
  });

  it("executes live host-rule fixtures instead of accepting authored policy decisions", async () => {
    const start = startCommand("fixture-live-rule");
    const input = { run_in_background: true };
    const check = vi.fn(async () => ({ fastDeny: "live rule denied background work" } as const));
    const command = testScenarioCommand(start.runId, "live-rule-command", agentFrameworkHostCommand({
      type: "hostPreToolUse",
      workflow: {},
      context: fixtureHostPreToolContext("Agent", input),
      toolCallId: "live-rule-tool",
      turnId: null,
      name: "Agent",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: false,
    }), { source: start.source, recordedAt: "2026-01-01T00:00:01.000Z" });
    const report = await runScenarioFixture({
      name: "live-rule",
      initialRun: { startCommand: start, seedRecords: [] },
      commands: [command],
      effects: { mode: "live" },
      expectations: [
        { kind: "commandResult", commandId: command.commandId, status: "denied" },
        {
          kind: "record",
          eventType: "extension.observed",
          payloadContains: {
            extensionId: AGENT_FRAMEWORK_RULE_EXTENSION_ID,
            event: "rule.evaluation.completed",
            evaluation: {
              ruleId: "agent-framework.rule.live-fixture-rule",
              result: "fastDeny",
            },
          },
          count: 1,
        },
        { kind: "snapshot", path: "toolCalls.0.authorization.final", equals: "denied" },
      ],
    }, {
      liveEffectExecutor: new RulePipelineEffectExecutor({
        rules: [{
          name: "live-fixture-rule",
          displayName: "Live fixture rule",
          priority: 1,
          appealable: false,
          usesLlm: false,
          promptSection: "",
          check,
        }],
      }),
    });

    expect(check).toHaveBeenCalledOnce();
    expect(report.pass).toBe(true);
  });

  it("rejects malformed host context before evaluating a host pre-tool rule", async () => {
    const start = startCommand("fixture-invalid-host-context");
    const input = { command: "pwd" };
    const check = vi.fn(async () => null);
    const command = testScenarioCommand(start.runId, "invalid-host-context-command", agentFrameworkHostCommand({
      type: "hostPreToolUse",
      workflow: {},
      context: {},
      toolCallId: "invalid-host-context-tool",
      turnId: null,
      name: "Bash",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: false,
    }), { source: start.source, recordedAt: "2026-01-01T00:00:01.000Z" });
    const report = await runScenarioFixture({
      name: "invalid-host-context",
      initialRun: { startCommand: start, seedRecords: [] },
      commands: [command],
      effects: { mode: "live" },
      expectations: [{
        kind: "commandResult",
        commandId: command.commandId,
        status: "failed",
        reasonContains: "requires canonical pre-tool host context",
      }],
    }, {
      liveEffectExecutor: new RulePipelineEffectExecutor({
        rules: [{
          name: "must-not-run-with-invalid-context",
          displayName: "Must Not Run With Invalid Context",
          priority: 1,
          appealable: false,
          usesLlm: false,
          promptSection: "",
          check,
        }],
      }),
    });

    expect(report.pass).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it("keeps committed sentiment regressions on the live canonical host-command lane", async () => {
    const happy = validateScenarioFixture(JSON.parse(await fs.readFile(new URL(
      "../../scenarios/expected-to-pass/sentiment-happy-allows.json",
      import.meta.url,
    ), "utf8")));
    const calm = validateScenarioFixture(JSON.parse(await fs.readFile(new URL(
      "../../scenarios/expected-to-fail/sentiment-agent-resets-anger-after-calm-directive.json",
      import.meta.url,
    ), "utf8")));

    expect(happy.effects).toEqual({ mode: "live" });
    expect(agentFrameworkHostCommandData(happy.commands.at(-1)!.payload)?.type).toBe("hostPreToolUse");
    expect(calm.effects).toEqual({ mode: "live" });
    expect(agentFrameworkHostCommandData(calm.commands.at(-1)!.payload)?.type).toBe("hostUserPromptSubmitted");
    expect(calm.expectations.map((expectation) => expectation.kind)).toEqual(expect.arrayContaining([
      "record",
      "snapshotOneOf",
      "snapshotStringContains",
    ]));
  });

  it("keeps every committed behavioral fixture on the live canonical host-command lane", async () => {
    const scenariosRoot = new URL("../../scenarios/", import.meta.url);
    let count = 0;
    for (const group of AGENT_FRAMEWORK_COMMITTED_BEHAVIOR_SOURCES) {
      const directory = new URL(`${group}/`, scenariosRoot);
      const files = (await fs.readdir(directory)).filter((file) => file.endsWith(".json"));
      for (const file of files) {
        const fixture = validateScenarioFixture(JSON.parse(await fs.readFile(new URL(file, directory), "utf8")));
        const hostCommands = fixture.commands.flatMap((command) => {
          const hostCommand = agentFrameworkHostCommandData(command.payload);
          return hostCommand ? [hostCommand] : [];
        });
        const commandTypes = hostCommands.map((command) => command.type);
        expect(fixture.name).toBe(file.slice(0, -5));
        expect(fixture.effects).toEqual({ mode: "live" });
        expect(hostCommands.some(isAgentFrameworkLiveBehaviorCommand)).toBe(true);
        expect(fixture.commands.map((command) => command.payload.type)).not.toContain("toolRequested");
        expect(fixture.commands.map((command) => command.payload.type)).not.toContain("requestEffect");
        if (commandTypes.includes("hostPreToolUse")) {
          expect(fixture.expectations).toContainEqual({
            kind: "snapshotArrayMinLength",
            path: "/effects/0/result/evaluations",
            minLength: 1,
          });
        }
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(90);
  });

  it("runs a migrated policy regression through the production rule registry", async () => {
    const fixture = validateScenarioFixture(JSON.parse(await fs.readFile(new URL(
      "../../scenarios/expected-to-pass/sentiment-angry-blocks-edits.json",
      import.meta.url,
    ), "utf8")));
    const report = await runScenarioFixture(fixture, {
      liveEffectExecutor: new RulePipelineEffectExecutor(),
    });

    expect(report.expectationResults.filter((result) => !result.pass)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.records).toContainEqual(expect.objectContaining({
      eventType: "extension.observed",
      payload: expect.objectContaining({
        extensionId: AGENT_FRAMEWORK_RULE_EXTENSION_ID,
        event: "rule.evaluation.completed",
        evaluation: expect.objectContaining({
          ruleId: "agent-framework.rule.prediction-block",
          result: "fastDeny",
        }),
      }),
    }));
  });

  it("allows the promoted Codex exec_command workflow regression", async () => {
    const fixture = validateScenarioFixture(JSON.parse(await fs.readFile(new URL(
      "../../scenarios/expected-to-pass/prediction-block-requires-exec-command-after-fulfilled-should-allow.json",
      import.meta.url,
    ), "utf8")));
    const report = await runScenarioFixture(fixture, {
      liveEffectExecutor: new RulePipelineEffectExecutor({ rules: [predictionBlockRule] }),
    });

    expect(report.expectationResults.filter((result) => !result.pass)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.commandResults[
      "prediction-block-requires-exec-command-after-fulfilled-should-allow-target-tool"
    ]).toMatchObject({ status: "allowed" });
  });

  it("fails undeclared tool-policy effects in strict deterministic fixtures", async () => {
    const start = startCommand("strict-tool-policy");
    const tool = toolCommand(start.runId, "strict-tool-command", "strict-tool");
    const report = await runScenarioFixture({
      name: "strict-tool-policy",
      initialRun: { startCommand: start, seedRecords: [] },
      commands: [tool],
      effects: { mode: "deterministic", outcomes: {}, rejectUnexpected: true },
      expectations: [{
        kind: "commandResult",
        commandId: tool.commandId,
        status: "failed",
        reasonContains: "Unexpected fixture effect: policy:strict-tool",
      }],
    });

    expect(report.pass).toBe(true);
    expect(report.finalSnapshot.effects[0]).toMatchObject({
      effectId: "policy:strict-tool",
      status: "failed",
      error: "Unexpected fixture effect: policy:strict-tool",
    });
  });

  it("compares nested fixture values independently of object insertion order", async () => {
    const start = startCommand("fixture-key-order");
    const orderedValue = {
      outer: { alpha: 1, beta: { first: true, second: false }, label: "live rule lane", items: [1, 2] },
    };
    const reversedExpectation = {
      outer: { items: [1, 2], label: "live rule lane", beta: { second: false, first: true }, alpha: 1 },
    };
    const report = await runScenarioFixture({
      name: "key-order",
      initialRun: { startCommand: start, seedRecords: [] },
      commands: [{
        commandId: "key-order-state",
        runId: start.runId,
        source: start.source,
        recordedAt: "2026-01-01T00:00:01.000Z",
        payload: {
          type: "stateSliceChanged",
          key: "testKeyOrder",
          schemaId: "agent-framework://state/test-key-order",
          status: "validated",
          source: "test",
          visibility: "localSensitive",
          value: orderedValue,
          diagnostics: [],
        },
      }],
      effects: { mode: "deterministic", outcomes: {}, rejectUnexpected: true },
      expectations: [
        {
          kind: "snapshot",
          path: "stateSlices.testKeyOrder.value",
          equals: reversedExpectation,
        },
        {
          kind: "snapshotOneOf",
          path: "/stateSlices/testKeyOrder/value/outer/alpha",
          values: [0, 1],
        },
        {
          kind: "snapshotStringContains",
          path: "/stateSlices/testKeyOrder/value/outer/label",
          value: "rule",
        },
        {
          kind: "snapshotArrayMinLength",
          path: "/stateSlices/testKeyOrder/value/outer/items",
          minLength: 2,
        },
      ],
    });

    expect(report.pass).toBe(true);
  });

  it("materializes and replays a generic effect without generated claim identity", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-generic-effect-");
    const runtime = createTestScenarioRuntime({
      root,
      effectExecutor: { async execute() { return { result: { value: "stable" } }; } },
    });
    const start = startCommand("generic-effect-run");
    await runtime.dispatch(start);
    await runtime.dispatch({
      commandId: "generic-effect-command",
      runId: start.runId,
      source: start.source,
      recordedAt: "2026-01-01T00:00:01.000Z",
      payload: { type: "requestEffect", effectId: "generic-effect", effectType: "test.generic", parameters: {} },
    });
    const fixture = await materializeScenarioFixture(runtime, start.runId, { name: "generic-effect" });
    expect((await runScenarioFixture(fixture)).pass).toBe(true);
  });

  it("materializes and replays failed generic effects with the same terminal evidence", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-fixture-test-");
    const runtime = createTestScenarioRuntime({
      root,
      effectExecutor: { async execute() { throw new Error("fixture generic failure"); } },
    });
    const start = startCommand("failed-generic-effect-run");
    const request = effectCommand(start, "failed-generic-command", "failed-generic-effect", "test.generic");
    await runtime.dispatch(start);
    const originalResult = await runtime.dispatch(request);

    const fixture = await materializeScenarioFixture(runtime, start.runId, { name: "failed-generic-effect" });
    const report = await runScenarioFixture(fixture);

    expect(fixture.effects).toMatchObject({
      mode: "deterministic",
      outcomes: {
        "failed-generic-effect": { outcome: "failed", error: "fixture generic failure" },
      },
    });
    expect(report.pass).toBe(true);
    expect(report.commandResults[request.commandId]).toEqual(originalResult);
    expect(report.finalSnapshot.effects[0]).toMatchObject({
      effectId: "failed-generic-effect",
      status: "failed",
      error: "fixture generic failure",
    });
    expect(terminalEffectEvidence(report.records)).toEqual(
      terminalEffectEvidence(await runtime.recordsAfter(start.runId, 0)),
    );
  });

  it("materializes and replays failed tool-policy effects with identical tool failure records", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-fixture-test-");
    const runtime = createTestScenarioRuntime({
      root,
      effectExecutor: {
        async execute(request) {
          expect(request.effectType).toBe(TOOL_POLICY_EFFECT_TYPE);
          throw new Error("fixture policy failure");
        },
      },
    });
    const start = startCommand("failed-policy-effect-run");
    const tool = toolCommand(start.runId, "failed-policy-tool-command", "failed-policy-tool");
    await runtime.dispatch(start);
    const originalResult = await runtime.dispatch(tool);
    const originalTool = (await runtime.snapshot(start.runId)).toolCalls[0];

    const fixture = await materializeScenarioFixture(runtime, start.runId, { name: "failed-policy-effect" });
    const report = await runScenarioFixture(fixture);

    expect(fixture.effects).toMatchObject({
      mode: "deterministic",
      outcomes: {
        "policy:failed-policy-tool": { outcome: "failed", error: "fixture policy failure" },
      },
    });
    expect(report.pass).toBe(true);
    expect(report.commandResults[tool.commandId]).toEqual(originalResult);
    expect(report.finalSnapshot.toolCalls[0]).toMatchObject({
      id: originalTool?.id,
      status: originalTool?.status,
      error: originalTool?.error,
      authorization: originalTool?.authorization,
    });
    expect(terminalEffectEvidence(report.records)).toEqual(
      terminalEffectEvidence(await runtime.recordsAfter(start.runId, 0)),
    );
  });

  it("rebases guarded host commands when replaying production rule progress", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-fixture-test-");
    const rules: PreToolRule[] = [
      {
        name: "fixture-fast-allow",
        displayName: "Fixture fast allow",
        priority: 1,
        appealable: false,
        usesLlm: false,
        promptSection: "",
        async check() { return { fastAllow: "fixture allowed" }; },
      },
      {
        name: "fixture-short-circuited",
        displayName: "Fixture short circuited",
        priority: 2,
        appealable: false,
        usesLlm: false,
        promptSection: "",
        async check() { throw new Error("short-circuited rule should not run"); },
      },
    ];
    const runtime = createTestScenarioRuntime({
      root,
      effectExecutor: new RulePipelineEffectExecutor({ rules }),
    });
    const start = {
      ...startCommand("rule-progress-materialize-run"),
      source: { kind: "hostHook" as const, adapter: "codex", nativeSessionId: "fixture-native" },
    };
    await runtime.dispatch(start);
    const tool = {
      ...toolCommand(start.runId, "rule-progress-tool-command", "rule-progress-tool"),
      source: start.source,
      expectedSnapshotRevision: (await runtime.snapshot(start.runId)).revision,
    };
    await runtime.dispatch(tool);
    const afterTool = await runtime.snapshot(start.runId);
    await runtime.dispatch({
      commandId: "guarded-workflow-command",
      runId: start.runId,
      source: start.source,
      recordedAt: "2026-01-01T00:00:02.000Z",
      expectedSnapshotRevision: afterTool.revision,
      payload: {
        type: "stateSliceChanged",
        key: "session.workflow",
        schemaId: "agent-framework://state/session-workflow",
        status: "validated",
        source: "guarded-host-workflow",
        visibility: "localSensitive",
        value: afterTool.stateSlices["session.workflow"]?.value ?? {},
        diagnostics: [],
      },
    });
    const originalStatuses = agentFrameworkRulePipelineState(
      await runtime.snapshot(start.runId),
    ).evaluations.map((evaluation) => evaluation.status);

    const fixture = await materializeScenarioFixture(runtime, start.runId, { name: "rule-progress" });
    const ruleExpectations = fixture.expectations.flatMap((expectation) =>
      expectation.kind === "record" &&
        expectation.eventType === "extension.observed" &&
        expectation.payloadContains?.extensionId === AGENT_FRAMEWORK_RULE_EXTENSION_ID &&
        typeof expectation.payloadContains.event === "string" &&
        expectation.payloadContains.event.startsWith("rule.evaluation.")
        ? [expectation]
        : []
    );
    const report = await runScenarioFixture(fixture);

    expect(originalStatuses).toEqual(["completed", "skipped"]);
    expect(ruleExpectations).not.toHaveLength(0);
    expect(ruleExpectations.every((expectation) =>
      expectation.payloadContains === undefined || !("effectId" in expectation.payloadContains)
    )).toBe(true);
    expect(fixture.commands).toHaveLength(2);
    expect(fixture.commands.every((command) => command.expectedSnapshotRevision === undefined)).toBe(true);
    expect(report.expectationResults.filter((result) => !result.pass)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(agentFrameworkRulePipelineState(report.finalSnapshot).evaluations.map((evaluation) => evaluation.status))
      .toEqual(originalStatuses);
  });

  it("materializes and replays explicit effect cancellation with the original reason", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-fixture-test-");
    const runtime = createTestScenarioRuntime({
      root,
      effectExecutor: {
        async execute() { throw new ScenarioEffectCancellationError("fixture cancellation"); },
      },
    });
    const start = startCommand("cancelled-effect-run");
    const request = effectCommand(start, "cancelled-effect-command", "cancelled-effect", "test.generic");
    await runtime.dispatch(start);
    const originalResult = await runtime.dispatch(request);

    const fixture = await materializeScenarioFixture(runtime, start.runId, { name: "cancelled-effect" });
    const report = await runScenarioFixture(fixture);

    expect(fixture.effects).toMatchObject({
      mode: "deterministic",
      outcomes: {
        "cancelled-effect": { outcome: "cancelled", reason: "fixture cancellation" },
      },
    });
    expect(report.pass).toBe(true);
    expect(report.commandResults[request.commandId]).toEqual(originalResult);
    expect(report.finalSnapshot.effects[0]).toMatchObject({
      effectId: "cancelled-effect",
      status: "cancelled",
      error: null,
    });
    expect(terminalEffectEvidence(report.records)).toEqual(
      terminalEffectEvidence(await runtime.recordsAfter(start.runId, 0)),
    );
  });

  it("injects declared effect results through the normal runtime effect loop", async () => {
    const start = startCommand("fixture-effect");
    const effect = testScenarioCommand(start.runId, "request-effect", {
      type: "requestEffect",
      effectId: "effect-1",
      effectType: "fixture.lookup",
      parameters: { input: "hello" },
    }, { source: start.source, recordedAt: "2026-01-01T00:00:01.000Z" });
    const report = await runScenarioFixture({
      name: "deterministic-effect",
      initialRun: { startCommand: start, seedRecords: [] },
      commands: [effect],
      effects: {
        mode: "deterministic",
        outcomes: {
          "effect-1": {
            outcome: "completed",
            result: { answer: 42 },
            metadata: { model: "fixture" },
          },
        },
        rejectUnexpected: true,
      },
      expectations: [
        { kind: "snapshot", path: "effects.0.status", equals: "completed" },
        { kind: "snapshot", path: "effects.0.result.answer", equals: 42 },
      ],
    });

    expect(report.pass).toBe(true);
  });

  it("materializes canonical journal commands into a replayable fixture", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-fixture-test-");
    const runtime = createTestScenarioRuntime({ root });
    const start = startCommand("fixture-materialize");
    await runtime.dispatch(start);
    await runtime.dispatch(toolCommand(start.runId, "tool-materialize", "tool-2"));

    const fixture = await materializeScenarioFixture(runtime, start.runId, { name: "materialized" });
    const report = await runScenarioFixture(fixture);

    expect(report.pass).toBe(true);
    expect(fixture.commands.map((command) => command.payload.type)).toEqual(["toolRequested"]);
  });

  it("materializes and replays sanitized digest-bearing tool and transcript commands", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-redacted-fixture-");
    const runtime = createTestScenarioRuntime({ root, maximumInlineBytes: 64 });
    const start = startCommand("redacted-digest-materialize");
    await runtime.dispatch(start);
    const toolSecret = "tool-secret-value-123456";
    const toolInput = { authorization: `Bearer ${toolSecret}`, command: "inspect" };
    await runtime.dispatch(testScenarioCommand(start.runId, "redacted-tool", {
      type: "toolRequested",
      toolCallId: "t1",
      turnId: "r1",
      name: "Read",
      input: toolInput,
      inputDigest: digestScenarioValue(toolInput),
      requiresUserDecision: false,
    }));
    const transcriptSecret = "transcript-secret-value-123456";
    const transcriptToolSecret = "transcript-tool-secret-123456";
    const transcriptContent = `API_TOKEN=${transcriptSecret}`;
    const transcriptToolInput = { apiToken: transcriptToolSecret };
    const transcriptData = {
      messages: [{
        id: "m1",
        turnId: "r2",
        role: "assistant" as const,
        content: transcriptContent,
        contentDigest: digestScenarioValue(transcriptContent),
        status: "completed" as const,
      }],
      tools: [{
        id: "t2",
        turnId: "r2",
        name: "Read",
        input: transcriptToolInput,
        inputDigest: digestScenarioValue(transcriptToolInput),
        status: "completed" as const,
        output: [],
        error: null,
      }],
    };
    await runtime.dispatch(testScenarioCommand(start.runId, "redacted-transcript", {
      type: "nativeTranscriptObserved",
      data: { ...transcriptData, digest: digestScenarioValue(transcriptData) },
    }));

    const fixture = await materializeScenarioFixture(runtime, start.runId, {
      name: "redacted-digest-materialized",
    });
    const serialized = JSON.stringify(fixture);
    for (const secret of [toolSecret, transcriptSecret, transcriptToolSecret]) {
      expect(serialized).not.toContain(secret);
    }
    assertScenarioCommandDigests(fixture.initialRun.startCommand);
    fixture.commands.forEach((command) => assertScenarioCommandDigests(command));
    const report = await runScenarioFixture(fixture);
    expect(report.expectationResults.filter((result) => !result.pass)).toEqual([]);
    expect(report.pass).toBe(true);
  });

  it("materializes canonical host behavior as a live fixture", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-fixture-test-");
    const rule: PreToolRule = {
      name: "materialized-live-rule",
      displayName: "Materialized live rule",
      priority: 1,
      appealable: false,
      usesLlm: false,
      promptSection: "",
      async check() { return { fastDeny: "live materialized denial" }; },
    };
    const executor = new RulePipelineEffectExecutor({ rules: [rule] });
    const runtime = createTestScenarioRuntime({ root, effectExecutor: executor });
    const start = startCommand("materialized-live-run");
    const input = { command: "npm test" };
    await runtime.dispatch(start);
    await runtime.dispatch({
      commandId: "materialized-live-command",
      runId: start.runId,
      source: start.source,
      recordedAt: "2026-01-01T00:00:01.000Z",
      payload: agentFrameworkHostCommand({
        type: "hostPreToolUse",
        workflow: {},
        context: fixtureHostPreToolContext("Bash", input),
        toolCallId: "materialized-live-tool",
        turnId: null,
        name: "Bash",
        input,
        inputDigest: digestScenarioValue(input),
        requiresUserDecision: false,
      }),
    });

    const fixture = await materializeScenarioFixture(runtime, start.runId, { name: "materialized-live" });
    const report = await runScenarioFixture(fixture, { liveEffectExecutor: executor });

    expect(fixture.effects).toEqual({ mode: "live" });
    expect(fixture.commands.map((command) =>
      agentFrameworkHostCommandData(command.payload)?.type
    )).toEqual(["hostPreToolUse"]);
    expect(report.pass).toBe(true);
  });

  it("materializes and replays a mirrored parallel-batch sibling without inventing evaluations", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-fixture-batch-mirror-");
    const rule: PreToolRule = {
      name: "materialized-batch-leader-rule",
      displayName: "Materialized batch leader rule",
      priority: 1,
      appealable: false,
      usesLlm: false,
      promptSection: "",
      async check() { return { fastAllow: "batch leader allowed" }; },
    };
    const executor = new RulePipelineEffectExecutor({ rules: [rule] });
    const runtime = createTestScenarioRuntime({ root, effectExecutor: executor });
    const start = startCommand("materialized-batch-mirror-run");
    const leaderInput = { command: "pwd" };
    const siblingInput = { file_path: "/fixture/README.md" };
    const calls = [
      { toolCallId: "batch-leader", name: "Bash", input: leaderInput, mayRequireContinuation: false },
      { toolCallId: "batch-sibling", name: "Read", input: siblingInput, mayRequireContinuation: false },
    ];
    await runtime.dispatch(start);
    for (const [position, call] of calls.entries()) {
      await runtime.dispatch(testScenarioCommand(
        start.runId,
        `materialized-batch-command-${position}`,
        agentFrameworkHostCommand({
          type: "hostPreToolUse",
          workflow: {},
          context: fixtureHostPreToolContext(call.name, call.input, {
            leaderId: calls[0]!.toolCallId,
            position,
            batchSize: calls.length,
            allIds: calls.map(({ toolCallId }) => toolCallId),
            calls,
          }),
          toolCallId: call.toolCallId,
          turnId: null,
          name: call.name,
          input: call.input,
          inputDigest: digestScenarioValue(call.input),
          requiresUserDecision: false,
        }),
        { source: start.source, recordedAt: `2026-01-01T00:00:0${position + 1}.000Z` },
      ));
    }

    const fixture = await materializeScenarioFixture(runtime, start.runId, {
      name: "materialized-batch-mirror",
    });
    const report = await runScenarioFixture(fixture, { liveEffectExecutor: executor });

    expect(fixture.expectations).toContainEqual({
      kind: "snapshotArrayMinLength",
      path: "/effects/0/result/evaluations",
      minLength: 2,
    });
    expect(fixture.expectations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "snapshotArrayMinLength",
        path: "/effects/1/result/evaluations",
      }),
    ]));
    expect(report.finalSnapshot.effects.map((effect) =>
      effectEvaluationCount(effect.result)
    )).toEqual([2, 0]);
    expect(report.pass).toBe(true);
  });

  it("replays slash authorization, completed-roundtrip, and Stop error context from host state", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-fixture-host-transcript-context-");
    const contextRule: PreToolRule = {
      name: "materialized-host-transcript-context",
      displayName: "Materialized host transcript context",
      priority: 1,
      appealable: false,
      usesLlm: false,
      events: ["PreToolUse", "Stop"],
      promptSection: "",
      async check(context) {
        if (context.hookEvent === "PreToolUse") {
          return context.cachedSnippetSideTaskDischarged === true &&
              context.slashCommandAllowedTools?.includes("mcp-confirm") === true
            ? { fastAllow: "canonical host transcript context replayed" }
            : { fastDeny: "canonical host transcript context missing" };
        }
        return context.priorErrorContext?.some((error) =>
          error.source === "tool-failure" && error.toolUseId === "failed-check"
        )
          ? null
          : { stopBlock: "canonical Stop error context missing" };
      },
    };
    const executor = new RulePipelineEffectExecutor({ rules: [contextRule] });
    const runtime = createTestScenarioRuntime({ root, effectExecutor: executor });
    const start = startCommand("materialized-host-transcript-context-run");
    const input = { file_path: "/fixture/README.md" };
    await runtime.dispatch(start);
    await runtime.dispatch(testScenarioCommand(
      start.runId,
      "materialized-host-transcript-pretool",
      agentFrameworkHostCommand({
        type: "hostPreToolUse",
        workflow: {},
        context: fixtureHostPreToolContext("Read", input, null, {
          recentUserMessages: ["complete the validation"],
          latestUserMessage: "complete the validation",
          latestUserLogicText: "complete the validation",
          cachedSnippetSideTaskDischarged: true,
          slashCommandAllowedTools: ["mcp-confirm"],
        }),
        toolCallId: "materialized-context-tool",
        turnId: null,
        name: "Read",
        input,
        inputDigest: digestScenarioValue(input),
        requiresUserDecision: false,
      }),
      { source: start.source, recordedAt: "2026-01-01T00:00:01.000Z" },
    ));
    await runtime.dispatch(testScenarioCommand(
      start.runId,
      "materialized-host-transcript-stop",
      agentFrameworkHostCommand({
        type: "hostStopped",
        workflow: {},
        context: fixtureHostStopContext(),
        lastAssistantMessage: "I fixed the failing check.",
      }),
      { source: start.source, recordedAt: "2026-01-01T00:00:02.000Z" },
    ));

    const fixture = await materializeScenarioFixture(runtime, start.runId, {
      name: "materialized-host-transcript-context",
    });
    const report = await runScenarioFixture(fixture, { liveEffectExecutor: executor });

    expect(report.finalSnapshot.effects.map((effect) => effect.result)).toEqual([
      expect.objectContaining({ kind: "toolPolicyEvaluation", decision: "allow" }),
      expect.objectContaining({ kind: "hookRuleEvaluation", event: "Stop", decision: "allow" }),
    ]);
    expect(report.pass).toBe(true);
  });

  it("materializes and replays deterministic batch-order denial with zero evaluations", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-fixture-batch-order-");
    const executor = new RulePipelineEffectExecutor({ rules: [] });
    const runtime = createTestScenarioRuntime({ root, effectExecutor: executor });
    const start = startCommand("materialized-batch-order-run");
    const input = { description: "delegate work" };
    const calls = [
      { toolCallId: "order-leader", name: "Agent", input, mayRequireContinuation: true },
      {
        toolCallId: "order-later",
        name: "Bash",
        input: { command: "pwd" },
        mayRequireContinuation: false,
      },
    ];
    await runtime.dispatch(start);
    await runtime.dispatch(testScenarioCommand(
      start.runId,
      "materialized-batch-order-command",
      agentFrameworkHostCommand({
        type: "hostPreToolUse",
        workflow: {},
        context: fixtureHostPreToolContext("Agent", input, {
          leaderId: calls[0]!.toolCallId,
          position: 0,
          batchSize: calls.length,
          allIds: calls.map(({ toolCallId }) => toolCallId),
          calls,
        }),
        toolCallId: calls[0]!.toolCallId,
        turnId: null,
        name: "Agent",
        input,
        inputDigest: digestScenarioValue(input),
        requiresUserDecision: false,
      }),
      { source: start.source, recordedAt: "2026-01-01T00:00:01.000Z" },
    ));

    const fixture = await materializeScenarioFixture(runtime, start.runId, {
      name: "materialized-batch-order",
    });
    const report = await runScenarioFixture(fixture, { liveEffectExecutor: executor });

    expect(fixture.expectations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "snapshotArrayMinLength" }),
    ]));
    expect(report.finalSnapshot.effects[0]?.result).toMatchObject({
      kind: "toolPolicyEvaluation",
      decision: "deny",
      evaluations: [],
    });
    expect(report.pass).toBe(true);
  });

  it("materializes a recovered run without unreplayable storage expectations", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-fixture-test-");
    const runtime = createTestScenarioRuntime({ root });
    const start = startCommand("fixture-recovered");
    await runtime.dispatch(start);
    await runtime.dispatch(toolCommand(start.runId, "tool-before-recovery", "tool-recovered"));
    const snapshotPath = runSnapshotPath(start.runId, root);
    const staleSnapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    staleSnapshot.lastRecordSeq = 0;
    await fs.writeFile(snapshotPath, JSON.stringify(staleSnapshot), "utf8");

    expect((await runtime.recordsAfter(start.runId, 0)).some((record) =>
      record.eventType === "recovery.completed"
    )).toBe(true);
    const fixture = await materializeScenarioFixture(runtime, start.runId, { name: "recovered" });
    const materializedRecordTypes = fixture.expectations.flatMap((expectation) =>
      expectation.kind === "record" ? [expectation.eventType] : []
    );

    expect(materializedRecordTypes).not.toContain("recovery.completed");
    expect(materializedRecordTypes).not.toContain("store.diagnostic");
    expect((await runScenarioFixture(fixture)).pass).toBe(true);
  });

  it("hydrates artifact-backed strings and structured inputs before fixture replay", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-fixture-test-");
    const runtime = createTestScenarioRuntime({ root });
    const start = startCommand("artifact-materialize");
    const content = "large assistant content ".repeat(3_000);
    const input = {
      command: "large structured tool input ".repeat(3_000),
      nested: { value: "x".repeat(70 * 1_024) },
    };
    await runtime.dispatch(start);
    await runtime.dispatch({
      commandId: "artifact-message",
      runId: start.runId,
      source: start.source,
      recordedAt: "2026-01-01T00:00:01.000Z",
      payload: {
        type: "assistantMessageCompleted",
        messageId: "artifact-message-1",
        turnId: "artifact-turn-1",
        content,
        contentDigest: digestScenarioValue(content),
      },
    });
    await runtime.dispatch({
      commandId: "artifact-tool",
      runId: start.runId,
      source: start.source,
      recordedAt: "2026-01-01T00:00:02.000Z",
      payload: {
        type: "toolRequested",
        toolCallId: "artifact-tool-1",
        turnId: "artifact-turn-1",
        name: "Bash",
        input,
        inputDigest: digestScenarioValue(input),
        requiresUserDecision: false,
      },
    });

    const artifact = (await runtime.snapshot(start.runId)).artifacts[0];
    const literalMarker = `fixture literal\n[artifact ${artifact.digest}]`;
    await runtime.dispatch({
      commandId: "artifact-literal-message",
      runId: start.runId,
      source: start.source,
      recordedAt: "2026-01-01T00:00:03.000Z",
      payload: {
        type: "assistantMessageCompleted",
        messageId: "artifact-literal-message",
        turnId: "artifact-turn-2",
        content: literalMarker,
        contentDigest: digestScenarioValue(literalMarker),
      },
    });

    const fixture = await materializeScenarioFixture(runtime, start.runId, { name: "artifact-materialized" });
    const message = fixture.commands.find((command) => command.payload.type === "assistantMessageCompleted");
    const tool = fixture.commands.find((command) => command.payload.type === "toolRequested");
    expect(message?.payload).toMatchObject({ content, contentDigest: digestScenarioValue(content) });
    expect(tool?.payload).toMatchObject({ input, inputDigest: digestScenarioValue(input) });
    expect(fixture.commands.find((command) => command.commandId === "artifact-literal-message")?.payload)
      .toMatchObject({ content: literalMarker, contentDigest: digestScenarioValue(literalMarker) });
    const report = await runScenarioFixture(fixture);
    expect(report.expectationResults.filter((result) => !result.pass)).toEqual([]);
    expect(report.pass).toBe(true);
  });

  it("keeps persisted feedback out of materialized commands and expectations", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-fixture-test-");
    const runtime = createTestScenarioRuntime({ root });
    const start = startCommand("feedback-materialize");
    const content = "A stable assistant response";
    await runtime.dispatch(start);
    await runtime.dispatch({
      commandId: "feedback-message",
      runId: start.runId,
      source: start.source,
      recordedAt: "2026-01-01T00:00:01.000Z",
      payload: {
        type: "assistantMessageCompleted",
        messageId: "feedback-message-1",
        turnId: "feedback-turn-1",
        content,
        contentDigest: digestScenarioValue(content),
      },
    });
    for (const [index, vote] of (["up", "down"] as const).entries()) {
      await runtime.dispatch({
        commandId: `feedback-${index + 1}`,
        runId: start.runId,
        source: start.source,
        recordedAt: `2026-01-01T00:00:0${index + 2}.000Z`,
        payload: {
          type: "submitFeedback",
          targetKind: "assistantMessage",
          targetId: "feedback-message-1",
          vote,
          note: `vote-${index + 1}`,
          idempotencyKey: `feedback-key-${index + 1}`,
          expectedTargetDigest: digestScenarioValue(content),
          author: { subjectId: "fixture-user", clientId: "fixture-client", clientVersion: "1" },
        },
      });
    }

    const fixture = await materializeScenarioFixture(runtime, start.runId, { name: "feedback-materialized" });
    const report = await runScenarioFixture(fixture);

    expect(report.pass).toBe(true);
    expect(fixture.commands.filter((command) => command.payload.type === "submitFeedback")).toHaveLength(0);
    expect(fixture.expectations.filter((expectation) =>
      expectation.kind === "record" && expectation.eventType === "feedback.changed"
    )).toHaveLength(0);
    expect((await runtime.snapshot(start.runId)).feedback["fixture-user:assistantMessage:feedback-message-1"])
      .toMatchObject({
      vote: "down",
      note: "vote-2",
    });
    expect(report.finalSnapshot.feedback).toEqual({});
  });

  it("materializes a host-hook run with fixture provenance", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-fixture-test-");
    const runtime = createTestScenarioRuntime({ root });
    const start = {
      ...startCommand("host-materialize"),
      source: { kind: "hostHook" as const, adapter: "codex" },
    };
    await runtime.dispatch(start);

    const fixture = await materializeScenarioFixture(runtime, start.runId, { name: "host-materialized" });
    const report = await runScenarioFixture(fixture);

    expect(report.pass).toBe(true);
    expect(fixture.initialRun.startCommand.source).toEqual({ kind: "scenarioFixture", adapter: "codex" });
  });

  it("materializes records and snapshot from one revision even when a commit follows the read", async () => {
    const root = await createTemporaryTestRoot(roots, "agent-framework-fixture-test-");
    const store = new CommitAfterViewStore(root);
    const runtime = createTestScenarioRuntime({ root, store });
    const start = startCommand("atomic-materialize");
    await runtime.dispatch(start);
    store.arm(async () => {
      await runtime.dispatch({
        commandId: "close-after-view",
        runId: start.runId,
        source: start.source,
        recordedAt: "2026-01-01T00:00:01.000Z",
        payload: { type: "closeRun" },
      });
    });

    const fixture = await materializeScenarioFixture(runtime, start.runId, { name: "atomic-materialized" });

    expect(store.viewOpenCount).toBe(1);
    expect(fixture.commands.some((command) => command.commandId === "close-after-view")).toBe(false);
    expect(fixture.expectations).toContainEqual({ kind: "snapshot", path: "status", equals: "running" });
    expect((await runtime.snapshot(start.runId)).status).toBe("closed");
  });

  it("rejects commands that target a different run", () => {
    const start = startCommand("fixture-invalid");
    expect(() => validateScenarioFixture({
      name: "invalid",
      initialRun: { startCommand: start, seedRecords: [] },
      commands: [toolCommand("other-run", "tool-invalid", "tool-3")],
      effects: { mode: "deterministic", outcomes: {}, rejectUnexpected: true },
      expectations: [],
    })).toThrow(/must match startCommand\.runId/);
  });
});

function toolCommand(runId: string, commandId: string, toolCallId: string): ScenarioCommand {
  const input = { command: "echo hello" };
  return testScenarioCommand(runId, commandId, {
    type: "toolRequested",
    toolCallId,
    turnId: null,
    name: "Bash",
    input,
    inputDigest: digestScenarioValue(input),
    requiresUserDecision: false,
  }, {
    source: { kind: "scenarioFixture" },
    recordedAt: "2026-01-01T00:00:01.000Z",
  });
}

function injectFixtureCleanupFailure(failure: Error): {
  remove: ReturnType<typeof vi.spyOn>;
  restore(): Promise<void>;
} {
  const realRm = fsModule.promises.rm.bind(fsModule.promises);
  let failedRoot: string | null = null;
  const remove = vi.spyOn(fsModule.promises, "rm").mockImplementation(async (target, options) => {
    const targetPath = String(target);
    if (path.basename(targetPath).startsWith("scenario-fixture-")) {
      failedRoot = targetPath;
      throw failure;
    }
    return realRm(target, options);
  });
  return {
    remove,
    async restore() {
      remove.mockRestore();
      if (failedRoot) await fs.rm(failedRoot, { recursive: true, force: true });
    },
  };
}

function fixtureHostPreToolContext(
  rawToolName: string,
  rawToolInput: JsonValue,
  batch: JsonValue = null,
  overrides: Record<string, JsonValue> = {},
) {
  return {
    adapter: "codex",
    nativeSessionId: "fixture-native-session",
    transcriptPath: "/fixture/transcript.jsonl",
    sessionDir: "/fixture/session",
    projectDir: "/fixture",
    workingDir: "/fixture",
    permissionMode: "default",
    collaborationMode: null,
    planMode: false,
    planModeDetection: { active: false, mode: null, source: "none" },
    host: {
      adapter: "codex",
      projectDir: "/fixture",
      configRoot: "/fixture/.codex",
      plansRoot: "/fixture/.codex/plans",
      instructionFiles: [],
      instructionLabel: "AGENTS.md",
    },
    preTool: {
      rawToolName,
      rawToolInput,
      outsideRootPath: null,
      latestUserMessage: "",
      latestUserLogicText: "",
      recentUserMessages: [],
      cachedSnippetSideTaskDischarged: false,
      slashCommandAllowedTools: null,
      planExit: false,
      batch,
      ...overrides,
    },
  };
}

function fixtureHostStopContext() {
  const base = fixtureHostPreToolContext("Read", { file_path: "/fixture/README.md" });
  const { preTool: _preTool, ...common } = base;
  void _preTool;
  return {
    ...common,
    stop: {
      lastAssistantMessage: "I fixed the failing check.",
      assistantTextCandidates: ["I fixed the failing check."],
      latestAssistantText: "I fixed the failing check.",
      latestUserText: "fix the failing check",
      priorErrorContext: [{
        source: "tool-failure",
        provenance: ["transcript"],
        tool: "Bash",
        toolUseId: "failed-check",
        text: "command failed with exit code 1",
        isError: true,
      }],
      planExitText: null,
      stopBlockDisabled: false,
    },
  };
}

function effectEvaluationCount(result: JsonValue | undefined): number | null {
  if (result === null || result === undefined || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  return Array.isArray(result.evaluations) ? result.evaluations.length : null;
}

function effectCommand(
  start: ScenarioCommand,
  commandId: string,
  effectId: string,
  effectType: string,
): ScenarioCommand {
  return testScenarioCommand(
    start.runId,
    commandId,
    { type: "requestEffect", effectId, effectType, parameters: {} },
    { source: start.source, recordedAt: "2026-01-01T00:00:01.000Z" },
  );
}

function terminalEffectEvidence(records: readonly { eventType: string; payload: Record<string, unknown> }[]) {
  const terminalTypes = new Set([
    "effect.completed",
    "effect.failed",
    "effect.cancelled",
    "tool.authorization.policyResolved",
    "tool.authorization.finalResolved",
    "command.completed",
  ]);
  return records.filter((record) => terminalTypes.has(record.eventType)).map((record) => {
    const { claimId: _claimId, previousClaimId: _previousClaimId, ...payload } = record.payload;
    return { eventType: record.eventType, payload };
  });
}
