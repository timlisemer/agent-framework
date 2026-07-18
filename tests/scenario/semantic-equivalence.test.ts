import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeEncoder } from "../../adapters/claude/encoder.js";
import { codexEncoder } from "../../adapters/codex/encoder.js";
import { toPostToolUse, toPreToolUse } from "../../adapters/codex/hooks/input.js";
import type { AdapterEncoder } from "../../src/adapter/types.js";
import { ScenarioGateway } from "../../src/ai-backend/gateway.js";
import type { ProviderRunner } from "../../src/ai-backend/provider.js";
import { ScenarioProviderManager } from "../../src/ai-backend/scenario-provider-manager.js";
import {
  HOST_HOOK_CAPABILITIES,
  canonicalHookRunId,
  dispatchPostToolUse,
  dispatchPreToolUse,
  dispatchStop,
} from "../../src/entrypoints/host-hook.js";
import { runScenarioFixture } from "../../src/scenario/fixtures/runner.js";
import type { ScenarioFixture } from "../../src/scenario/fixtures/types.js";
import type { ScenarioCommand } from "../../src/scenario/protocol/commands.js";
import { digestScenarioValue } from "../../src/scenario/protocol/digest.js";
import type { ScenarioRecord } from "../../src/scenario/protocol/records.js";
import {
  type ScenarioSnapshot,
} from "../../src/scenario/protocol/snapshot.js";
import {
  agentFrameworkEffectPlanner,
} from "../../src/effects/rule-pipeline-contract.js";
import { ScenarioRuntime } from "../../src/scenario/runtime/runtime.js";
import {
  createDeterministicPolicyExecutor,
  createTestScenarioRuntime,
} from "../helpers/scenario-runtime.js";
import { canonicalToolHistory } from "../../src/effects/tool-history.js";
import { agentFrameworkHostExtensionHandler } from "../../src/effects/host-command.js";
import { agentFrameworkStateSlicePolicy } from "../../src/effects/state-slices.js";
import { agentFrameworkScenarioFixturePolicy } from "../../src/effects/scenario-fixture-policy.js";
import {
  testResolvedProvider,
  testScenarioCommandFactory,
  testStartRunCommand,
} from "../helpers/scenario-fixtures.js";
import {
  cleanupTemporaryTestRoots,
  createTemporaryTestRoot,
} from "../helpers/temporary-root.js";
import { withEnvironmentForTest } from "../helpers/environment.js";

const roots: string[] = [];
const environmentRestorers: Array<() => void> = [];
const equivalenceStartPayload = {
  capabilities: HOST_HOOK_CAPABILITIES,
  storagePolicy: "ephemeral" as const,
  configuration: { nonInteractiveToolFallback: "deny", rulePipeline: "shared" },
};

afterEach(async () => {
  await cleanupTemporaryTestRoots(roots);
  for (const restore of environmentRestorers.splice(0).reverse()) restore();
});

describe("ScenarioRuntime real cross-entrypoint semantic equivalence", () => {
  it("produces the same tool policy and terminal state through every production boundary", async () => {
    const direct = await executeDirectRuntime();
    const fixture = await executeFixtureRunner();
    const claude = await executeHookAdapter("claude", claudeEncoder);
    const codex = await executeHookAdapter("codex", codexEncoder);
    const provider = await executeProviderPermissionCallback();

    for (const result of [fixture, claude, codex, provider]) {
      expect(result.semantic, result.name).toEqual(direct.semantic);
      expect(result.decision, result.name).toBe("allowed");
    }
  });

  it("initializes simultaneous first-use host hooks with one run.started transition", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-equivalence-host-start-race-");
    const transcriptPath = path.join(root, "codex.jsonl");
    await fs.writeFile(transcriptPath, "", "utf8");
    setHostEnvironment("codex", root);
    const runtime = createTestScenarioRuntime({
      root: path.join(root, "canonical-runs"),
      effectExecutor: allowPolicyExecutor,
    });
    const base = {
      session_id: "codex-native-session",
      transcript_path: transcriptPath,
      cwd: root,
      tool_name: "Read",
      tool_input: nestedToolInput(),
    };

    await Promise.all([
      dispatchPreToolUse({ ...base, tool_use_id: "concurrent-tool-1" }, codexEncoder, { runtime }),
      dispatchPreToolUse({ ...base, tool_use_id: "concurrent-tool-2" }, codexEncoder, { runtime }),
      dispatchPreToolUse({ ...base, tool_use_id: "concurrent-tool-3" }, codexEncoder, { runtime }),
    ]);
    const runId = canonicalHookRunId("codex", transcriptPath);
    expect((await runtime.recordsAfter(runId, 0)).filter((record) =>
      record.eventType === "run.started"
    )).toHaveLength(1);
  });

  it("keeps PreToolUse slash authorization and parallel-batch context from the committed observation", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-pretool-observation-boundary-");
    const transcriptPath = path.join(root, "claude.jsonl");
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        message: {
          id: "workflow-user",
          role: "user",
          content: "<command-name>/quickconfirm</command-name>",
        },
      }),
      JSON.stringify({
        message: {
          id: "batch-leader-message",
          role: "assistant",
          content: [{ type: "tool_use", id: "batch-leader", name: "Read", input: { file_path: "A.md" } }],
        },
      }),
      JSON.stringify({
        message: {
          id: "batch-current-message",
          role: "assistant",
          content: [{ type: "tool_use", id: "batch-current", name: "Edit", input: { file_path: "B.md" } }],
        },
      }),
    ].join("\n") + "\n", "utf8");
    setHostEnvironment("claude", root);

    class MutatingTranscriptRuntime extends ScenarioRuntime {
      public override async dispatch(command: ScenarioCommand) {
        const result = await super.dispatch(command);
        if (command.payload.type === "nativeTranscriptObserved") {
          await fs.writeFile(transcriptPath, JSON.stringify({
            message: { id: "mutated-user", role: "user", content: "unrelated mutation" },
          }) + "\n", "utf8");
        }
        return result;
      }
    }
    const runtime = new MutatingTranscriptRuntime({
      root: path.join(root, "canonical-runs"),
      effectExecutor: allowPolicyExecutor,
      effectPlanner: agentFrameworkEffectPlanner,
      extensionHandler: agentFrameworkHostExtensionHandler,
      stateSlicePolicy: agentFrameworkStateSlicePolicy,
    });

    await dispatchPreToolUse({
      session_id: "pretool-observation-session",
      transcript_path: transcriptPath,
      cwd: root,
      tool_name: "Edit",
      tool_input: { file_path: "B.md" },
      tool_use_id: "batch-current",
    }, claudeEncoder, { runtime });

    const snapshot = await runtime.snapshot(canonicalHookRunId("claude", transcriptPath));
    expect(snapshot.stateSlices["host.context"]?.value).toMatchObject({
      preTool: {
        slashCommandAllowedTools: ["mcp-confirm", "Edit", "MultiEdit", "Write"],
        batch: {
          leaderId: "batch-leader",
          position: 1,
          allIds: ["batch-leader", "batch-current"],
        },
      },
    });
  });

  it("keeps Stop response and error context from the committed observation", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-stop-observation-boundary-");
    const transcriptPath = path.join(root, "claude.jsonl");
    await fs.writeFile(transcriptPath, [
      JSON.stringify({ message: { id: "stop-user", role: "user", content: "fix the failing check" } }),
      JSON.stringify({
        message: {
          id: "stop-tool-request",
          role: "assistant",
          content: [{ type: "tool_use", id: "failed-check", name: "Bash", input: { command: "just check" } }],
        },
      }),
      JSON.stringify({
        message: {
          id: "stop-tool-result",
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "failed-check",
            content: "command failed with exit code 1",
            is_error: true,
          }],
        },
      }),
      JSON.stringify({ message: { id: "stop-assistant", role: "assistant", content: "I still need to fix it." } }),
    ].join("\n") + "\n", "utf8");
    setHostEnvironment("claude", root);

    class MutatingTranscriptRuntime extends ScenarioRuntime {
      public override async dispatch(command: ScenarioCommand) {
        const result = await super.dispatch(command);
        if (command.payload.type === "nativeTranscriptObserved") {
          await fs.writeFile(transcriptPath, "", "utf8");
        }
        return result;
      }
    }
    const runtime = new MutatingTranscriptRuntime({
      root: path.join(root, "canonical-runs"),
      effectExecutor: allowPolicyExecutor,
      effectPlanner: agentFrameworkEffectPlanner,
      extensionHandler: agentFrameworkHostExtensionHandler,
      stateSlicePolicy: agentFrameworkStateSlicePolicy,
    });

    await dispatchStop({
      session_id: "stop-observation-session",
      transcript_path: transcriptPath,
      cwd: root,
      last_assistant_message: null,
    }, claudeEncoder, { runtime });

    const snapshot = await runtime.snapshot(canonicalHookRunId("claude", transcriptPath));
    expect(snapshot.stateSlices["host.context"]?.value).toMatchObject({
      stop: {
        latestAssistantText: "I still need to fix it.",
        latestUserText: "fix the failing check",
        priorErrorContext: [{
          source: "tool-failure",
          tool: "Bash",
          toolUseId: "failed-check",
          text: "command failed with exit code 1",
        }],
      },
    });
  });

  it("retries an older transcript observation after a newer replacement commits", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-equivalence-transcript-race-");
    const transcriptPath = path.join(root, "claude.jsonl");
    await fs.writeFile(transcriptPath, claudeTranscript(false), "utf8");
    setHostEnvironment("claude", root);
    let releaseOlder!: () => void;
    let markOlderDelayed!: () => void;
    const olderRelease = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const olderDelayed = new Promise<void>((resolve) => { markOlderDelayed = resolve; });
    class DelayedTranscriptRuntime extends ScenarioRuntime {
      private delayed = false;

      public override async dispatch(command: ScenarioCommand) {
        if (!this.delayed && command.payload.type === "nativeTranscriptObserved") {
          const messages = command.payload.data?.messages ?? [];
          if (messages.some((message) => message.content === "older transcript")) {
            this.delayed = true;
            markOlderDelayed();
            await olderRelease;
          }
        }
        return super.dispatch(command);
      }
    }
    const runtime = new DelayedTranscriptRuntime({
      root: path.join(root, "canonical-runs"),
      effectExecutor: allowPolicyExecutor,
      effectPlanner: agentFrameworkEffectPlanner,
      extensionHandler: agentFrameworkHostExtensionHandler,
      stateSlicePolicy: agentFrameworkStateSlicePolicy,
    });
    const base = {
      session_id: "claude-transcript-race",
      transcript_path: transcriptPath,
      cwd: root,
      tool_name: "Read",
      tool_input: nestedToolInput(),
    };

    const olderHook = dispatchPreToolUse(
      { ...base, tool_use_id: "hook-from-older-read" },
      claudeEncoder,
      { runtime },
    );
    await olderDelayed;
    await fs.writeFile(transcriptPath, claudeTranscript(true), "utf8");
    await dispatchPreToolUse(
      { ...base, tool_use_id: "hook-from-newer-read" },
      claudeEncoder,
      { runtime },
    );
    releaseOlder();
    await olderHook;

    const runId = canonicalHookRunId("claude", transcriptPath);
    const snapshot = await runtime.snapshot(runId);
    expect(snapshot.conversation).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "older-message", content: "older transcript" }),
      expect.objectContaining({ id: "newer-message", content: "newer transcript" }),
    ]));
    expect(snapshot.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "older-tool", status: "completed" }),
      expect.objectContaining({ id: "newer-tool", status: "completed" }),
    ]));
    expect(snapshot.stateSlices["transcript.native"]?.value).toMatchObject({
      messageIds: ["older-message", "newer-message"],
      toolCallIds: ["older-tool", "newer-tool"],
    });
    expect((await runtime.recordsAfter(runId, 0))).not.toContainEqual(expect.objectContaining({
      eventType: "message.retired",
      payload: expect.objectContaining({ messageId: "newer-message" }),
    }));
  });

  it.each([
    { policyDecision: "allow" as const, terminalStatus: "completed" as const, transcriptError: false },
    { policyDecision: "deny" as const, terminalStatus: "denied" as const, transcriptError: true },
  ])("preserves a host-owned $terminalStatus tool when it later appears in the native transcript", async ({
    policyDecision,
    terminalStatus,
    transcriptError,
  }) => {
    const root = await createTemporaryTestRoot(roots, `scenario-host-transcript-${terminalStatus}-`);
    const transcriptPath = path.join(root, "claude.jsonl");
    await fs.writeFile(transcriptPath, "", "utf8");
    setHostEnvironment("claude", root);
    const hostToolId = `toolu_host_${terminalStatus}`;
    const runtime = createTestScenarioRuntime({
      root: path.join(root, "canonical-runs"),
      effectExecutor: createDeterministicPolicyExecutor({
        transformToolResult: (result, parameters) =>
          parameters.toolCallId === hostToolId && policyDecision === "deny"
            ? { ...result, decision: "deny" as const, reason: "Denied by the host policy", agent: "test-policy" }
            : result,
        metadata: { transcriptOwnershipEffect: true },
      }),
    });
    const hostInput = {
      session_id: "claude-native-session",
      transcript_path: transcriptPath,
      cwd: root,
      tool_name: "Read",
      tool_input: nestedToolInput(),
      tool_use_id: hostToolId,
    };

    const firstOutput = await dispatchPreToolUse(hostInput, claudeEncoder, { runtime });
    expect(firstOutput.exitCode).toBe(0);
    if (policyDecision === "allow") {
      await dispatchPostToolUse({ ...hostInput, tool_response: { ok: true } }, claudeEncoder, { runtime });
    }
    const runId = canonicalHookRunId("claude", transcriptPath);
    const originalTool = (await runtime.snapshot(runId)).toolCalls.find((tool) => tool.id === hostToolId);
    expect(originalTool?.status).toBe(terminalStatus);

    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        message: {
          id: "assistant-native-turn",
          role: "assistant",
          content: [{
            type: "tool_use",
            id: hostToolId,
            name: "Read",
            input: nestedToolInput(),
          }],
        },
      }),
      JSON.stringify({
        message: {
          id: "user-native-turn",
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: hostToolId,
            content: [{ type: "text", text: transcriptError ? "denied" : "done" }],
            is_error: transcriptError,
          }],
        },
      }),
    ].join("\n") + "\n", "utf8");

    const laterOutput = await dispatchPreToolUse({
      ...hostInput,
      tool_use_id: "toolu_later_hook",
    }, claudeEncoder, { runtime });
    expect(laterOutput.exitCode).toBe(0);
    const snapshot = await runtime.snapshot(runId);
    expect(snapshot.toolCalls.filter((tool) => tool.id === hostToolId)).toHaveLength(1);
    expect(snapshot.toolCalls.find((tool) => tool.id === hostToolId)).toEqual(originalTool);
    expect(snapshot.toolCalls).toContainEqual(expect.objectContaining({ id: "toolu_later_hook" }));
    expect((await runtime.recordsAfter(runId, 0))).not.toContainEqual(expect.objectContaining({
      eventType: "tool.retired",
      entityRef: { kind: "toolCall", id: hostToolId },
    }));

    await fs.writeFile(transcriptPath, "", "utf8");
    const afterCompaction = await dispatchPreToolUse({
      ...hostInput,
      tool_use_id: "toolu_after_compaction",
    }, claudeEncoder, { runtime });
    expect(afterCompaction.exitCode).toBe(0);
    const compacted = await runtime.snapshot(runId);
    expect(compacted.toolCalls).not.toContainEqual(expect.objectContaining({ id: hostToolId }));
    expect(canonicalToolHistory(compacted)).not.toContainEqual(expect.objectContaining({ toolUseId: hostToolId }));
    expect((await runtime.recordsAfter(runId, 0)).filter((record) =>
      record.eventType === "tool.retired" && record.payload.toolCallId === hostToolId
    )).toHaveLength(1);
  });

  it("reconciles missing Codex hook IDs with the later native tool ID and retires it once", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-codex-missing-tool-id-");
    const transcriptPath = path.join(root, "codex.jsonl");
    await fs.writeFile(transcriptPath, "", "utf8");
    setHostEnvironment("codex", root);
    const runtime = createTestScenarioRuntime({
      root: path.join(root, "canonical-runs"),
      effectExecutor: allowPolicyExecutor,
    });
    const raw = {
      sessionId: "codex-missing-id-session",
      transcriptPath,
      cwd: root,
      toolName: "Read",
      toolInput: nestedToolInput(),
    };
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(200);
    const preInput = toPreToolUse(raw);
    const postInput = toPostToolUse({ ...raw, toolResponse: { ok: true } });
    now.mockRestore();
    expect(preInput.tool_use_id).not.toBe(postInput.tool_use_id);

    await dispatchPreToolUse(preInput, codexEncoder, { runtime });
    await dispatchPostToolUse(postInput, codexEncoder, { runtime });
    const runId = canonicalHookRunId("codex", transcriptPath);
    expect((await runtime.snapshot(runId)).toolCalls).toMatchObject([{
      id: preInput.tool_use_id,
      status: "completed",
    }]);

    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "codex-real-tool-id",
          name: "Read",
          arguments: JSON.stringify(nestedToolInput()),
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "codex-real-tool-id",
          output: { ok: true },
        },
      }),
    ].join("\n") + "\n", "utf8");
    await dispatchPreToolUse({ ...preInput, tool_use_id: "codex-after-transcript" }, codexEncoder, { runtime });

    const reconciled = await runtime.snapshot(runId);
    expect(reconciled.toolCalls.filter((tool) =>
      tool.id === preInput.tool_use_id || tool.id === "codex-real-tool-id"
    )).toHaveLength(1);
    expect(reconciled.stateSlices["transcript.native"]?.value).toMatchObject({
      toolCallIds: [preInput.tool_use_id],
      toolAliases: { "codex-real-tool-id": preInput.tool_use_id },
    });

    await fs.writeFile(transcriptPath, "", "utf8");
    await dispatchPreToolUse({ ...preInput, tool_use_id: "codex-after-clear" }, codexEncoder, { runtime });
    await dispatchPreToolUse({ ...preInput, tool_use_id: "codex-after-second-clear" }, codexEncoder, { runtime });
    expect((await runtime.recordsAfter(runId, 0)).filter((record) =>
      record.eventType === "tool.retired" && record.payload.toolCallId === preInput.tool_use_id
    )).toHaveLength(1);
  });
});

async function executeDirectRuntime(): Promise<PathResult> {
  const root = await createTemporaryTestRoot(roots, "scenario-equivalence-direct-");
  const runtime = createTestScenarioRuntime({ root, effectExecutor: allowPolicyExecutor });
  const command = testScenarioCommandFactory(
    "direct-run",
    { kind: "gateway" },
    "2026-07-16T12:00:00.000Z",
  );
  await runtime.dispatch(testStartRunCommand({
    runId: "direct-run",
    source: { kind: "gateway" },
    payload: equivalenceStartPayload,
  }));
  const decision = await runtime.dispatch(command("tool", toolPayload(false)));
  await runtime.dispatch(command("started", { type: "toolExecutionStarted", toolCallId: "tool-1" }));
  await runtime.dispatch(command("completed", {
    type: "toolCompleted",
    toolCallId: "tool-1",
    output: { ok: true },
  }));
  return pathResult("direct runtime", decision.status, runtime, "direct-run");
}

async function executeFixtureRunner(): Promise<PathResult> {
  const root = await createTemporaryTestRoot(roots, "scenario-equivalence-fixture-");
  const command = testScenarioCommandFactory(
    "fixture-run",
    { kind: "scenarioFixture", adapter: "direct" },
    "2026-07-16T12:00:00.000Z",
  );
  const fixture: ScenarioFixture = {
    name: "real-entrypoint-equivalence",
    initialRun: {
      startCommand: testStartRunCommand({
        runId: "fixture-run",
        source: { kind: "scenarioFixture", adapter: "direct" },
        payload: equivalenceStartPayload,
      }),
      seedRecords: [],
    },
    commands: [
      command("tool", toolPayload(false)),
      command("started", { type: "toolExecutionStarted", toolCallId: "tool-1" }),
      command("completed", { type: "toolCompleted", toolCallId: "tool-1", output: { ok: true } }),
    ],
    effects: {
      mode: "deterministic",
      outcomes: {},
      rejectUnexpected: true,
      allowUndeclaredToolPolicy: true,
    },
    expectations: [],
  };
  const report = await runScenarioFixture(fixture, {
    root,
    policy: agentFrameworkScenarioFixturePolicy,
  });
  return {
    name: "scenario fixture runner",
    decision: String(report.commandResults.tool &&
      (report.commandResults.tool as { status?: string }).status),
    semantic: semanticProjection(report.finalSnapshot, report.records),
  };
}

async function executeHookAdapter(
  adapter: "claude" | "codex",
  encoder: AdapterEncoder,
): Promise<PathResult> {
  const root = await createTemporaryTestRoot(roots, `scenario-equivalence-${adapter}-`);
  const transcriptPath = path.join(root, `${adapter}.jsonl`);
  await fs.writeFile(transcriptPath, "", "utf8");
  setHostEnvironment(adapter, root);
  const runtime = createTestScenarioRuntime({
    root: path.join(root, "canonical-runs"),
    effectExecutor: allowPolicyExecutor,
  });
  const input = {
    session_id: `${adapter}-native-session`,
    transcript_path: transcriptPath,
    cwd: root,
    tool_name: "Read",
    tool_input: nestedToolInput(),
    tool_use_id: "tool-1",
  };
  const output = await dispatchPreToolUse(input, encoder, { runtime });
  expect(output.exitCode, `${adapter} native encoder`).toBe(0);
  if (adapter === "claude") expect(output.stdout).toContain("\"permissionDecision\":\"allow\"");
  await dispatchPostToolUse({ ...input, tool_response: { ok: true } }, encoder, { runtime });

  const runId = canonicalHookRunId(adapter, transcriptPath);
  return pathResult(`${adapter} hook adapter`, "allowed", runtime, runId);
}

async function executeProviderPermissionCallback(): Promise<PathResult> {
  const root = await createTemporaryTestRoot(roots, "scenario-equivalence-provider-");
  const runtime = createTestScenarioRuntime({ root, effectExecutor: allowPolicyExecutor });
  const manager = new ScenarioProviderManager({
    runtime,
    resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
    createRunner: (resolvedProvider, authorizeTool): ProviderRunner => ({
      resolvedProvider,
      async *runTurn(input) {
        const decision = await authorizeTool({
          toolCallId: "tool-1",
          turnId: input.turnId,
          toolName: "Read",
          toolInput: nestedToolInput(),
          signal: input.signal,
        });
        if (decision.decision !== "approve") throw new Error(decision.reason ?? "tool denied");
        yield { type: "toolExecutionStarted", toolCallId: "tool-1" };
        yield { type: "toolCompleted", toolCallId: "tool-1", output: { ok: true } };
      },
    }),
  });
  const { runId } = await manager.host.start({
    model: null,
    workingDir: root,
    systemPrompt: null,
    continuable: false,
    sdkRuntimeEnvironment: "isolated",
    runtimeHome: { kind: "native", configuration: {} },
  });
  await manager.host.send(runId, "turn-1", "Inspect the file");
  await waitForTool(runtime, runId, "waiting");
  const gateway = new ScenarioGateway(runtime, { providerHost: manager.host });
  const response = await gateway.handle({
    type: "request",
    requestId: "approve-provider-tool",
    payload: {
      operation: "submitToolDecision",
      runId,
      toolCallId: "tool-1",
      decision: "approve",
      reason: null,
    },
  });
  expect(response).toMatchObject({ ok: true, payload: { result: { status: "allowed" } } });
  await waitForTool(runtime, runId, "completed");
  const result = await pathResult("provider permission callback", "allowed", runtime, runId);
  await gateway.dispose();
  await manager.dispose();
  return result;
}

const allowPolicyExecutor = createDeterministicPolicyExecutor({
  metadata: { deterministicEquivalenceEffect: true },
});

type PathResult = {
  name: string;
  decision: string;
  semantic: ReturnType<typeof semanticProjection>;
};

async function pathResult(
  name: string,
  decision: string,
  runtime: ScenarioRuntime,
  runId: string,
): Promise<PathResult> {
  return {
    name,
    decision,
    semantic: semanticProjection(
      await runtime.snapshot(runId),
      await runtime.recordsAfter(runId, 0),
    ),
  };
}

const POLICY_RECORDS = new Set([
  "tool.requested",
  "effect.requested",
  "effect.started",
  "effect.completed",
  "tool.authorization.policyResolved",
  "tool.authorization.finalResolved",
  "tool.completed",
]);

function semanticProjection(snapshot: ScenarioSnapshot, records: ScenarioRecord[]) {
  const tool = snapshot.toolCalls.find((candidate) => candidate.id === "tool-1");
  if (!tool) throw new Error("equivalence path did not record tool-1");
  return {
    tool: {
      name: tool.name,
      input: tool.input,
      status: tool.status,
      policy: tool.authorization.policy,
      final: tool.authorization.final,
    },
    policyRecordTypes: records
      .map((record) => record.eventType)
      .filter((eventType) => POLICY_RECORDS.has(eventType)),
  };
}

function toolPayload(requiresUserDecision: boolean): Extract<ScenarioCommand["payload"], { type: "toolRequested" }> {
  const input = nestedToolInput();
  return {
    type: "toolRequested",
    toolCallId: "tool-1",
    turnId: "turn-1",
    name: "Read",
    input,
    inputDigest: digestScenarioValue(input),
    requiresUserDecision,
  };
}

function nestedToolInput() {
  return { file_path: "README.md", options: { line: 1, tags: ["safe", "structured"] } };
}

function setHostEnvironment(adapter: string, projectDir: string): void {
  environmentRestorers.push(withEnvironmentForTest({
    AGENT_FRAMEWORK_ADAPTER: adapter,
    AGENT_FRAMEWORK_PROJECT_DIR: projectDir,
  }));
}

function claudeTranscript(includeNewer: boolean): string {
  const turns = [
    {
      message: { id: "older-message", role: "user", content: "older transcript" },
    },
    {
      message: {
        id: "older-assistant",
        role: "assistant",
        content: [{ type: "tool_use", id: "older-tool", name: "Read", input: nestedToolInput() }],
      },
    },
    {
      message: {
        id: "older-result",
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "older-tool", content: "older result" }],
      },
    },
    ...(includeNewer ? [
      {
        message: { id: "newer-message", role: "user", content: "newer transcript" },
      },
      {
        message: {
          id: "newer-assistant",
          role: "assistant",
          content: [{ type: "tool_use", id: "newer-tool", name: "Read", input: nestedToolInput() }],
        },
      },
      {
        message: {
          id: "newer-result",
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "newer-tool", content: "newer result" }],
        },
      },
    ] : []),
  ];
  return `${turns.map((turn) => JSON.stringify(turn)).join("\n")}\n`;
}

async function waitForTool(
  runtime: ScenarioRuntime,
  runId: string,
  status: "waiting" | "completed",
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const tool = (await runtime.snapshot(runId)).toolCalls.find((candidate) => candidate.id === "tool-1");
    if (tool?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`provider tool did not reach ${status}`);
}
