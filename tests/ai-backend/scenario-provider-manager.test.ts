import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderRunner, ProviderToolAuthorization } from "../../src/ai-backend/provider.js";
import { ScenarioGateway } from "../../src/ai-backend/gateway.js";
import { ScenarioProviderManager } from "../../src/ai-backend/scenario-provider-manager.js";
import { toJsonValue, type RunSource } from "../../src/scenario/protocol/common.js";
import { digestScenarioValue } from "../../src/scenario/protocol/digest.js";
import { scenarioProtocolSchemaDigest } from "../../src/scenario/protocol/schema.js";
import { ScenarioRuntime } from "../../src/scenario/runtime/runtime.js";
import { RunRegistry } from "../../src/scenario/store/run-registry.js";
import type { ScenarioCommand } from "../../src/scenario/protocol/commands.js";
import type { ResolvedProvider } from "../../src/utils/provider-config.js";
import { RulePipelineEffectExecutor } from "../../src/effects/rule-pipeline-executor.js";
import type { PreToolRule } from "../../src/rules/types.js";
import type { ProviderSessionConfig } from "../../src/providers/provider-contract.js";
import { createTestScenarioRuntime } from "../helpers/scenario-runtime.js";
import { testResolvedProvider, testStartRunCommand } from "../helpers/scenario-fixtures.js";
import {
  cleanupTemporaryTestRoots,
  createTemporaryTestRoot,
} from "../helpers/temporary-root.js";
import { adapterSpecByName } from "../../src/adapter/spec.js";
import { toolApproveRule } from "../../src/rules/tool-approve.js";

const claudeQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: claudeQueryMock,
}));

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  vi.useRealTimers();
  claudeQueryMock.mockReset();
  await cleanupTemporaryTestRoots(roots);
});

describe("ScenarioProviderManager", () => {
  it("enforces Agent Framework provider runtime policy after the generic gateway boundary", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-runtime-policy-");
    const resolveProvider = vi.fn(() => testResolvedProvider({ sdkRuntime: "claude" }));
    const manager = new ScenarioProviderManager({
      runtime: createTestScenarioRuntime({ root }),
      resolveProvider,
    });

    await expect(manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "managed", configuration: { profile: "shared-credentials" } },
    })).rejects.toThrow();
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it("keeps native Codex homes observation-only and unbound from the Scenario run", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-native-codex-binding-");
    const runtime = createTestScenarioRuntime({ root });
    let resolvedConfig: ProviderSessionConfig | null = null;
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: (config) => {
        resolvedConfig = config;
        return testResolvedProvider({ sdkRuntime: "codex" });
      },
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn() {},
      }),
    });

    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });

    expect(resolvedConfig).not.toHaveProperty("scenarioBinding");
    expect((await runtime.snapshot(runId)).manifest.configuration).toMatchObject({
      authorizationBoundary: "providerObservation",
    });
    await manager.dispose();
  });

  it("binds managed hooks to both the canonical run and its storage root", async () => {
    const root = await createTemporaryTestRoot(
      roots,
      "scenario-provider-managed-root-binding-",
    );
    const runtime = createTestScenarioRuntime({ root });
    let resolvedConfig: ProviderSessionConfig | null = null;
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: (config) => {
        resolvedConfig = config;
        return testResolvedProvider({ sdkRuntime: "codex" });
      },
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn() {},
      }),
    });

    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "user",
      runtimeHome: { kind: "managed", configuration: { profile: "default" } },
    });

    expect(resolvedConfig).toMatchObject({
      scenarioBinding: { runId, root },
    });
    await manager.dispose();
  });

  it.each([
    { sdkRuntime: "claude" as const, discoveryEvent: "session_id", nativeSessionId: "claude-session-real" },
    { sdkRuntime: "codex" as const, discoveryEvent: "thread.started", nativeSessionId: "codex-thread-real" },
  ])("promotes a real $sdkRuntime ID reported by $discoveryEvent into canonical provenance", async ({
    sdkRuntime,
    nativeSessionId,
  }) => {
    const root = await createTemporaryTestRoot(roots, `scenario-provider-${sdkRuntime}-native-id-`);
    const runtime = createTestScenarioRuntime({ root });
    const assistantContent = `${sdkRuntime} session established`;
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime }),
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn(input) {
          yield { type: "providerStateObserved", data: { nativeSessionId } };
          yield {
            type: "assistantMessageCompleted",
            messageId: `${sdkRuntime}-assistant`,
            turnId: input.turnId,
            content: assistantContent,
            contentDigest: digestScenarioValue(assistantContent),
          };
        },
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });

    await manager.host.send(runId, `${sdkRuntime}-turn`, "discover native session");
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(runId)).conversation).toContainEqual(expect.objectContaining({
        content: assistantContent,
      }));
    });

    const snapshot = await runtime.snapshot(runId);
    expect(snapshot.providerState.nativeSessionId).toBe(nativeSessionId);
    expect(snapshot.manifest.nativeSessionIds).toContain(nativeSessionId);
    expect((await runtime.listRuns()).find((run) => run.runId === runId)?.nativeSessionIds)
      .toContain(nativeSessionId);
    expect((await new RunRegistry(root).findByNativeIdentifier(nativeSessionId))?.runId).toBe(runId);
    const assistantCommand = (await runtime.recordsAfter(runId, 0))
      .filter((record) => record.eventType === "command.accepted")
      .map((record) => record.payload.command)
      .find((command) =>
        command && typeof command === "object" && !Array.isArray(command) &&
        command.payload && typeof command.payload === "object" && !Array.isArray(command.payload) &&
        command.payload.type === "assistantMessageCompleted"
      );
    expect(assistantCommand).toMatchObject({
      source: { kind: "providerSdk", adapter: sdkRuntime, nativeSessionId },
    });
    await manager.dispose();
  });

  it("merges partial nested provider observations at the application boundary", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-metadata-merge-");
    const runtime = createTestScenarioRuntime({ root });
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "codex" }),
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn() {
          yield {
            type: "providerStateObserved",
            data: toJsonValue({
              context: { usedTokens: 10, maxTokens: 100 },
              compaction: { lastCompactedAt: "2026-07-16T12:00:00.000Z", events: [{ source: "first" }] },
            }),
          };
          yield {
            type: "providerStateObserved",
            data: toJsonValue({
              context: { remainingTokens: 90 },
              compaction: { lastCompactedAt: null },
            }),
          };
        },
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });

    await manager.host.send(runId, "provider-metadata-turn", "observe partial metadata");
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(runId)).providerState).toMatchObject({
        context: { usedTokens: 10, maxTokens: 100, remainingTokens: 90 },
        compaction: {
          lastCompactedAt: null,
          events: [{ source: "first" }],
        },
      });
    });
    await manager.dispose();
  });

  it.each([
    { sdkRuntime: "claude" as const, expectedName: "exec_command", expectedInput: { cmd: "pwd" } },
    { sdkRuntime: "codex" as const, expectedName: "Bash", expectedInput: { command: "pwd" } },
  ])("uses the $sdkRuntime adapter for OpenRouter tool provenance", async ({
    sdkRuntime,
    expectedName,
    expectedInput,
  }) => {
    const root = await createTemporaryTestRoot(roots, `scenario-provider-${sdkRuntime}-`);
    const runtime = createTestScenarioRuntime({ root });
    let authorizeTool: ProviderToolAuthorization | undefined;
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime }),
      createRunner: (resolvedProvider, authorize): ProviderRunner => {
        authorizeTool = authorize;
        return { resolvedProvider, async *runTurn() {} };
      },
    });

    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });
    const controller = new AbortController();
    const authorization = authorizeTool?.({
      toolCallId: `tool-${sdkRuntime}`,
      turnId: "turn-1",
      toolName: "exec_command",
      toolInput: { cmd: "pwd" },
      signal: controller.signal,
    });
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(runId)).toolCalls).toMatchObject([{
        name: expectedName,
        input: expectedInput,
      }]);
    });
    const snapshot = await runtime.snapshot(runId);
    expect(snapshot.manifest.adapter).toBe(sdkRuntime);
    expect(snapshot.capabilities.interactiveToolDecisions).toBe(sdkRuntime === "claude");
    expect(snapshot.manifest.configuration.toolAuthorization).toBe(
      sdkRuntime === "claude" ? "preExecution" : "observationOnly",
    );
    expect(snapshot.manifest.configuration).toMatchObject({
      model: "test-model",
      systemPromptDigest: digestScenarioValue(null),
      sdkRuntimeEnvironment: "isolated",
    });
    expect(snapshot.providerState.configuration).toEqual({
      model: "test-model",
      systemPromptDigest: digestScenarioValue(null),
      sdkRuntimeEnvironment: "isolated",
    });
    controller.abort();
    await authorization?.catch(() => undefined);
    await manager.dispose();
  });

  it("does not register an authorization waiter before tool input normalization succeeds", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-normalization-failure-");
    const runtime = createTestScenarioRuntime({ root });
    let authorizeTool: ProviderToolAuthorization | undefined;
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider, authorize): ProviderRunner => {
        authorizeTool = authorize;
        return { resolvedProvider, async *runTurn() {} };
      },
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });
    expect(authorizeTool).toBeDefined();
    await expect(authorizeTool!({
      toolCallId: "reusable-tool-id",
      turnId: "turn-1",
      toolName: "Read",
      toolInput: { invalid: 1n },
      signal: new AbortController().signal,
    })).rejects.toThrow();

    const controller = new AbortController();
    const pending = authorizeTool!({
      toolCallId: "reusable-tool-id",
      turnId: "turn-1",
      toolName: "Read",
      toolInput: { file_path: "README.md" },
      signal: controller.signal,
    });
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(runId)).toolCalls).toMatchObject([{
        id: "reusable-tool-id",
        status: "waiting",
      }]);
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "OperationCancelledError" });
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(runId)).toolCalls).toMatchObject([{
        id: "reusable-tool-id",
        status: "cancelled",
      }]);
    });
    await manager.dispose();
  });

  it("denies a provider-originated restricted MCP after canonicalization", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-restricted-mcp-");
    const observeAdapter = vi.fn(async () => null);
    const adapterProbeRule: PreToolRule = {
      name: "provider-adapter-probe",
      displayName: "Provider adapter probe",
      priority: 0,
      appealable: false,
      usesLlm: false,
      promptSection: "",
      check: observeAdapter,
    };
    const runtime = createTestScenarioRuntime({
      root,
      effectExecutor: new RulePipelineEffectExecutor({
        rules: [adapterProbeRule, { ...toolApproveRule, appealable: false }],
      }),
    });
    let authorizeTool: ProviderToolAuthorization | undefined;
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "codex" }),
      createRunner: (resolvedProvider, authorize): ProviderRunner => {
        authorizeTool = authorize;
        return { resolvedProvider, async *runTurn() {} };
      },
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });

    const decision = await authorizeTool!({
      toolCallId: "restricted-provider-mcp",
      turnId: "turn-1",
      toolName: adapterSpecByName("codex").mcpWireName("commit"),
      toolInput: { working_dir: root },
      signal: new AbortController().signal,
    });

    expect(decision).toEqual({
      decision: "deny",
      reason: expect.stringContaining("requires explicit workflow authorization"),
    });
    expect((await runtime.snapshot(runId)).toolCalls).toMatchObject([{
      id: "restricted-provider-mcp",
      name: "mcp-commit",
      status: "denied",
    }]);
    expect(observeAdapter).toHaveBeenCalledWith(expect.objectContaining({
      adapter: "codex",
      toolName: "mcp-commit",
      rawToolName: undefined,
    }));
    await manager.dispose();
  }, 10_000);

  it("commits run cancellation before awaiting a turn blocked in the rule pipeline", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-blocked-cancel-");
    let entered!: () => void;
    const effectEntered = new Promise<void>((resolve) => { entered = resolve; });
    const blockingRule: PreToolRule = {
      name: "provider-blocking-rule",
      displayName: "Provider blocking rule",
      priority: 1,
      appealable: false,
      usesLlm: false,
      promptSection: "",
      async check(context) {
        entered();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Effect cancelled", "AbortError"));
          if (context.signal?.aborted) abort();
          else context.signal?.addEventListener("abort", abort, { once: true });
        });
        return null;
      },
    };
    const runtime = createTestScenarioRuntime({
      root,
      effectExecutor: new RulePipelineEffectExecutor({ rules: [blockingRule] }),
    });
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider, authorizeTool): ProviderRunner => ({
        resolvedProvider,
        async *runTurn(input) {
          await authorizeTool({
            toolCallId: "blocked-policy-tool",
            turnId: input.turnId,
            toolName: "Bash",
            toolInput: { command: "pwd" },
            signal: input.signal,
          });
        },
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });
    await manager.host.send(runId, "blocked-turn", "inspect");
    await effectEntered;

    await expect(manager.host.cancel(runId, null)).resolves.toBeUndefined();

    const snapshot = await runtime.snapshot(runId);
    expect(snapshot.status).toBe("cancelled");
    expect(snapshot.effects[0]?.status).toBe("cancelled");
    await manager.dispose();
  });

  it("ignores provider lifecycle follow-ups after canonical tool denial", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-denied-follow-up-");
    const denyRule: PreToolRule = {
      name: "provider-deny-rule",
      displayName: "Provider deny rule",
      priority: 1,
      appealable: false,
      usesLlm: false,
      promptSection: "",
      async check() {
        return { fastDeny: "canonical policy denied this tool" };
      },
    };
    const runtime = createTestScenarioRuntime({
      root,
      effectExecutor: new RulePipelineEffectExecutor({ rules: [denyRule] }),
    });
    let turnCompleted = false;
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn(input) {
          const toolInput = { command: "pwd" };
          yield {
            type: "toolRequested",
            toolCallId: "denied-provider-tool",
            turnId: input.turnId,
            name: "Bash",
            input: toolInput,
            inputDigest: digestScenarioValue(toolInput),
            requiresUserDecision: false,
          };
          yield {
            type: "toolFailed",
            toolCallId: "denied-provider-tool",
            error: "provider reported the canonical denial",
            output: "permission denied",
          };
          turnCompleted = true;
        },
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });

    await manager.host.send(runId, "denied-provider-turn", "try denied tool");
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(runId)).toolCalls[0]).toMatchObject({
        id: "denied-provider-tool",
        status: "denied",
        error: "canonical policy denied this tool",
      });
    });
    await vi.waitFor(() => expect(turnCompleted).toBe(true));
    expect((await runtime.recordsAfter(runId, 0)).some((record) =>
      record.eventType === "runtime.error"
    )).toBe(false);
    expect((await runtime.snapshot(runId)).status).toBe("running");
    await manager.dispose();
  });

  it("disposes and detaches a runner immediately after whole-run cancellation", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-cancel-dispose-");
    const runtime = createTestScenarioRuntime({ root });
    const dispose = vi.fn(async () => undefined);
    const createResumeRunner = vi.fn((resolvedProvider: ResolvedProvider): ProviderRunner => ({
      resolvedProvider,
      async *runTurn() {},
    }));
    const resolvedProvider = testResolvedProvider({ sdkRuntime: "claude" });
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => resolvedProvider,
      createRunner: (resolved): ProviderRunner => ({
        resolvedProvider: resolved,
        async *runTurn() {},
        dispose,
      }),
      createResumeRunner,
    });
    const config = {
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated" as const,
      runtimeHome: { kind: "native" as const, configuration: {} },
    };
    const { runId } = await manager.host.start(config);

    await manager.host.cancel(runId, null);

    expect(dispose).toHaveBeenCalledOnce();
    expect((await runtime.snapshot(runId)).status).toBe("cancelled");
    await expect(manager.host.resume(runId, config, {
      sdkRuntime: "claude",
      nativeSessionId: "resumed-after-cancel",
    })).resolves.toEqual({ runId });
    expect(createResumeRunner).toHaveBeenCalledOnce();
    expect((await runtime.snapshot(runId)).status).toBe("running");
    await manager.dispose();
  });

  it.each([
    { operation: "cancel" as const, expectedStatus: "cancelled" },
    { operation: "close" as const, expectedStatus: "closed" },
    { operation: "dispose" as const, expectedStatus: "cancelled" },
  ])("disposes before awaiting a provider turn during $operation teardown", async ({
    operation,
    expectedStatus,
  }) => {
    const root = await createTemporaryTestRoot(roots, `scenario-provider-dispose-gated-${operation}-`);
    const runtime = createTestScenarioRuntime({ root });
    let markTurnEntered!: () => void;
    const turnEntered = new Promise<void>((resolve) => { markTurnEntered = resolve; });
    let releaseTurn!: () => void;
    const turnRelease = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const order: string[] = [];
    const dispose = vi.fn(async () => {
      order.push("dispose");
      releaseTurn();
    });
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn(input) {
          markTurnEntered();
          await turnRelease;
          order.push("turnSettled");
          const content = "late provider event after disposal";
          yield {
            type: "assistantMessageCompleted",
            messageId: `late-${input.turnId}`,
            turnId: input.turnId,
            content,
            contentDigest: digestScenarioValue(content),
          };
        },
        dispose,
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });
    await manager.host.send(runId, "dispose-gated-turn", "wait for disposal");
    await turnEntered;

    const teardown = operation === "cancel"
      ? manager.host.cancel(runId, null)
      : operation === "close"
        ? manager.host.close(runId)
        : manager.dispose();
    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`${operation} teardown hung before provider disposal`)),
        1_000,
      );
    });
    try {
      await expect(Promise.race([teardown, timeout])).resolves.toBeUndefined();
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    expect(dispose).toHaveBeenCalledOnce();
    expect(order).toEqual(["dispose", "turnSettled"]);
    const snapshot = await runtime.snapshot(runId);
    expect(snapshot.status).toBe(expectedStatus);
    expect(snapshot.conversation.map((message) => message.content)).toEqual(["wait for disposal"]);
    await manager.dispose();
  });

  it.each([
    { operation: "turn" as const, expectedStatus: "cancelled" },
    { operation: "run" as const, expectedStatus: "cancelled" },
    { operation: "close" as const, expectedStatus: "closed" },
    { operation: "dispose" as const, expectedStatus: "cancelled" },
  ])("bounds and detaches a non-cooperative provider during $operation cancellation", async ({
    operation,
    expectedStatus,
  }) => {
    const root = await createTemporaryTestRoot(roots, `scenario-provider-non-cooperative-${operation}-`);
    const runtime = createTestScenarioRuntime({ root });
    let markTurnEntered!: () => void;
    const turnEntered = new Promise<void>((resolve) => { markTurnEntered = resolve; });
    const neverSettles = new Promise<void>(() => {});
    let activeSignal: AbortSignal | undefined;
    const dispose = vi.fn(() => neverSettles);
    const manager = new ScenarioProviderManager({
      runtime,
      providerSettlementTimeoutMs: 20,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn(input) {
          activeSignal = input.signal;
          markTurnEntered();
          await neverSettles;
        },
        dispose,
      }),
    });
    const config = {
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated" as const,
      runtimeHome: { kind: "native" as const, configuration: {} },
    };
    const { runId } = await manager.host.start(config);
    await manager.host.send(runId, "non-cooperative-turn", "do not settle");
    await turnEntered;

    const cleanup = operation === "turn"
      ? manager.host.cancel(runId, "non-cooperative-turn")
      : operation === "run"
        ? manager.host.cancel(runId, null)
        : operation === "close"
          ? manager.host.close(runId)
          : manager.dispose();
    let timeoutId: NodeJS.Timeout | undefined;
    const hung = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`${operation} cleanup remained unbounded`)), 1_000);
    });
    try {
      await expect(Promise.race([cleanup, hung])).resolves.toBeUndefined();
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    expect(activeSignal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    const snapshot = await runtime.snapshot(runId);
    expect(snapshot.status).toBe(expectedStatus);
    expect(snapshot.recoveryDiagnostics).toContain(
      operation === "turn"
        ? "Provider cleanup timed out while cancelling turn non-cooperative-turn; provider detached"
        : "Provider cleanup timed out while tearing down the provider run; provider detached",
    );
    await expect(manager.host.send(runId, "after-detachment", "must not reach the provider"))
      .rejects.toThrow(`Unknown provider run: ${runId}`);
    await expect(manager.dispose()).resolves.toBeUndefined();
    if (operation === "turn") {
      const resumedManager = new ScenarioProviderManager({
        runtime,
        resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
        createResumeRunner: (resolvedProvider): ProviderRunner => ({
          resolvedProvider,
          async *runTurn() {},
        }),
      });
      await expect(resumedManager.host.resume(runId, config, {
        sdkRuntime: "claude",
        nativeSessionId: "resumed-after-timeout",
      })).resolves.toEqual({ runId });
      expect((await runtime.snapshot(runId)).status).toBe("running");
      await resumedManager.dispose();
    }
  });

  it("evicts a timed-out turn so later disposal does not wait for it again", async () => {
    vi.useFakeTimers();
    const root = await createTemporaryTestRoot(roots, "scenario-provider-background-task-eviction-");
    const runtime = createTestScenarioRuntime({ root });
    let markTurnEntered!: () => void;
    const turnEntered = new Promise<void>((resolve) => { markTurnEntered = resolve; });
    const neverSettles = new Promise<void>(() => {});
    const manager = new ScenarioProviderManager({
      runtime,
      providerSettlementTimeoutMs: 100,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn() {
          markTurnEntered();
          await neverSettles;
        },
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });
    await manager.host.send(runId, "never-settling-turn", "do not settle");
    await turnEntered;

    const cancellation = manager.host.cancel(runId, "never-settling-turn");
    await vi.advanceTimersByTimeAsync(100);
    await expect(cancellation).resolves.toBeUndefined();

    let disposed = false;
    const disposal = manager.dispose().then(() => { disposed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(disposed).toBe(true);
    await disposal;
  });

  it("keeps a shutdown-only child process alive until provider timeout diagnostics are durable", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-shutdown-process-");
    const compiledRoot = await createTemporaryTestRoot(roots, "scenario-provider-shutdown-build-");
    await execFileAsync(
      process.execPath,
      [
        path.join(process.cwd(), "node_modules/typescript/bin/tsc"),
        "--outDir",
        compiledRoot,
        "--declaration",
        "false",
        "--sourceMap",
        "false",
      ],
      { cwd: process.cwd(), timeout: 15_000 },
    );
    await fs.writeFile(path.join(compiledRoot, "package.json"), JSON.stringify({ type: "module" }));
    await fs.symlink(path.join(process.cwd(), "node_modules"), path.join(compiledRoot, "node_modules"), "dir");
    const helper = path.join(compiledRoot, "tests/helpers/provider-shutdown-child.js");
    const { stdout } = await execFileAsync(
      process.execPath,
      [helper, root],
      { cwd: process.cwd(), timeout: 3_000 },
    );

    expect(JSON.parse(stdout)).toEqual({
      status: "cancelled",
      diagnostic: "Provider cleanup timed out while tearing down the provider run; provider detached",
    });
  }, 20_000);

  it("detaches and terminalizes the real Claude runner when its SDK stream ignores abort", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-claude-timeout-");
    let markQueryEntered!: () => void;
    let releaseQuery!: () => void;
    const queryEntered = new Promise<void>((resolve) => { markQueryEntered = resolve; });
    const queryBarrier = new Promise<void>((resolve) => { releaseQuery = resolve; });
    claudeQueryMock.mockImplementation(() => (async function* () {
      markQueryEntered();
      await queryBarrier;
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "late event" }] },
      };
    })());
    const runtime = createTestScenarioRuntime({ root });
    const manager = new ScenarioProviderManager({
      runtime,
      providerSettlementTimeoutMs: 20,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: false,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });
    await manager.host.send(runId, "claude-timeout-turn", "wait forever");
    await queryEntered;

    await expect(manager.host.cancel(runId, "claude-timeout-turn")).resolves.toBeUndefined();
    const snapshot = await runtime.snapshot(runId);
    expect(snapshot.status).toBe("cancelled");
    expect(snapshot.recoveryDiagnostics).toContain(
      "Provider cleanup timed out while cancelling turn claude-timeout-turn; provider detached",
    );
    await expect(manager.host.send(runId, "late-turn", "must be detached"))
      .rejects.toThrow(`Unknown provider run: ${runId}`);

    releaseQuery();
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(runId)).conversation.map((message) => message.content))
        .toEqual(["wait forever"]);
    });
    await manager.dispose();
  });

  it("terminalizes the real Claude runner when its SDK stream rejects with a falsy reason", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-claude-falsy-error-");
    claudeQueryMock.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        return Promise.reject(undefined);
      },
    }));
    const runtime = createTestScenarioRuntime({ root });
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: false,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });

    await manager.host.send(runId, "claude-falsy-error-turn", "fail without an error object");
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(runId)).status).toBe("failed");
    });
    expect((await runtime.snapshot(runId)).errors).toMatchObject([{
      code: "runtime_error",
      message: "Runtime operation failed",
      recoverable: false,
    }]);
    expect((await runtime.recordsAfter(runId, 0)).some((record) =>
      record.eventType === "runtime.error"
    )).toBe(true);
    await manager.dispose();
  });

  it("terminalizes and detaches the real Claude runner when the SDK returns an error result", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-claude-error-result-");
    claudeQueryMock.mockImplementation(() => (async function* () {
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Claude execution failed"],
        usage: { input_tokens: 3, output_tokens: 1 },
      };
    })());
    const runtime = createTestScenarioRuntime({ root });
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: false,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });

    await manager.host.send(runId, "claude-error-result-turn", "fail as an SDK result");
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(runId))).toMatchObject({
        status: "failed",
        errors: [{
          code: "runtime_error",
          message: "Claude execution failed",
          recoverable: false,
          metadata: {
            claudeResultSubtype: "error_during_execution",
            errors: ["Claude execution failed"],
          },
        }],
      });
    });
    expect((await runtime.recordsAfter(runId, 0)).find((record) => record.eventType === "runtime.error"))
      .toMatchObject({
        payload: {
          metadata: {
            claudeResultSubtype: "error_during_execution",
            errors: ["Claude execution failed"],
          },
        },
      });
    await vi.waitFor(async () => {
      await expect(manager.host.send(runId, "claude-after-error", "must be detached"))
        .rejects.toThrow(`Unknown provider run: ${runId}`);
    });
    await manager.dispose();
  });

  it.each(["throws", "emits"] as const)(
    "detaches a provider turn that $mode a fatal error and resumes it in the same manager",
    async (mode) => {
      const root = await createTemporaryTestRoot(roots, `scenario-provider-fatal-${mode}-resume-`);
      const runtime = createTestScenarioRuntime({ root });
      const resolvedProvider = testResolvedProvider({ sdkRuntime: "claude" });
      const disposeFailedRunner = vi.fn();
      const createResumeRunner = vi.fn((resolved: ResolvedProvider): ProviderRunner => ({
        resolvedProvider: resolved,
        async *runTurn() {},
      }));
      const manager = new ScenarioProviderManager({
        runtime,
        resolveProvider: () => resolvedProvider,
        createRunner: (resolved): ProviderRunner => ({
          resolvedProvider: resolved,
          async *runTurn() {
            if (mode === "throws") throw new Error("provider turn exploded");
            yield {
              type: "runtimeErrorObserved",
              data: { message: "provider reported a fatal error", recoverable: false },
            };
          },
          dispose: disposeFailedRunner,
        }),
        createResumeRunner,
      });
      const config = {
        model: null,
        workingDir: root,
        systemPrompt: null,
        continuable: true,
        sdkRuntimeEnvironment: "isolated" as const,
        runtimeHome: { kind: "native" as const, configuration: {} },
      };
      const { runId } = await manager.host.start(config);

      await manager.host.send(runId, `fatal-${mode}-turn`, "fail this turn");
      await vi.waitFor(async () => {
        expect((await runtime.snapshot(runId)).status).toBe("failed");
        expect(disposeFailedRunner).toHaveBeenCalledOnce();
      });
      await expect(manager.host.send(runId, "detached-turn", "must not run"))
        .rejects.toThrow(`Unknown provider run: ${runId}`);

      await expect(manager.host.resume(runId, config, {
        sdkRuntime: "claude",
        nativeSessionId: `resumed-after-${mode}`,
      })).resolves.toEqual({ runId });
      expect(createResumeRunner).toHaveBeenCalledOnce();
      expect((await runtime.snapshot(runId)).status).toBe("running");
      await manager.dispose();
    },
  );

  it("does not cancel the active turn when a stale turn ID is requested", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-stale-cancel-");
    let entered!: () => void;
    const turnEntered = new Promise<void>((resolve) => { entered = resolve; });
    let activeSignal: AbortSignal | undefined;
    const manager = new ScenarioProviderManager({
      runtime: createTestScenarioRuntime({ root }),
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn(input) {
          activeSignal = input.signal;
          entered();
          await new Promise<void>((resolve) =>
            input.signal.addEventListener("abort", () => resolve(), { once: true })
          );
        },
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });
    await manager.host.send(runId, "turn-b", "continue working");
    await turnEntered;

    await manager.host.cancel(runId, "turn-a");

    expect(activeSignal?.aborted).toBe(false);
    expect((await manager.runtime.snapshot(runId)).status).toBe("running");
    await expect(manager.host.send(runId, "turn-c", "must remain reserved"))
      .rejects.toThrow("already has an active turn");
    await manager.host.cancel(runId, "turn-b");
    expect(activeSignal?.aborted).toBe(true);
    await manager.dispose();
  });

  it("reserves a turn before awaiting canonical message persistence", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-concurrent-send-");
    let releaseMessage!: () => void;
    const messageBarrier = new Promise<void>((resolve) => { releaseMessage = resolve; });
    class DeferredMessageRuntime extends ScenarioRuntime {
      public override async dispatch(command: ScenarioCommand) {
        if (command.payload.type === "userMessageSubmitted") await messageBarrier;
        return super.dispatch(command);
      }
    }
    const runtime = new DeferredMessageRuntime({ root });
    let admittedTurns = 0;
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn() {
          admittedTurns += 1;
        },
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });

    const first = manager.host.send(runId, "turn-1", "first");
    await expect(manager.host.send(runId, "turn-2", "second"))
      .rejects.toThrow("already has an active turn");
    releaseMessage();
    await first;
    await vi.waitFor(() => expect(admittedTurns).toBe(1));
    expect((await runtime.snapshot(runId)).conversation.map((message) => message.content)).toEqual(["first"]);
    await manager.dispose();
  });

  it("cancels a reserved turn during message persistence without starting provider work", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-admission-cancel-");
    let markMessageEntered!: () => void;
    let releaseMessage!: () => void;
    const messageEntered = new Promise<void>((resolve) => { markMessageEntered = resolve; });
    const messageBarrier = new Promise<void>((resolve) => { releaseMessage = resolve; });
    class DeferredMessageRuntime extends ScenarioRuntime {
      public override async dispatch(command: ScenarioCommand) {
        if (command.payload.type === "userMessageSubmitted" && command.payload.turnId === "turn-1") {
          markMessageEntered();
          await messageBarrier;
        }
        return super.dispatch(command);
      }
    }
    const runtime = new DeferredMessageRuntime({ root });
    const admittedTurns: string[] = [];
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn(input) {
          admittedTurns.push(input.turnId);
        },
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });

    const firstSend = manager.host.send(runId, "turn-1", "cancel before admission");
    await messageEntered;
    const cancellation = manager.host.cancel(runId, "turn-1");
    releaseMessage();
    await expect(Promise.all([firstSend, cancellation])).resolves.toEqual([undefined, undefined]);
    expect(admittedTurns).toEqual([]);

    await expect(manager.host.send(runId, "turn-2", "admit after cancellation"))
      .resolves.toBeUndefined();
    await vi.waitFor(() => expect(admittedTurns).toEqual(["turn-2"]));
    await manager.dispose();
  });

  it("delivers a decision submitted synchronously from the pending event", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-immediate-decision-");
    const runtime = createTestScenarioRuntime({ root });
    let authorizeTool: ProviderToolAuthorization | undefined;
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider, authorize): ProviderRunner => {
        authorizeTool = authorize;
        return { resolvedProvider, async *runTurn() {} };
      },
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });
    const gateway = new ScenarioGateway(runtime, { providerHost: manager.host });
    await expect(manager.host.settleToolDecision?.(
      runId,
      "not-pending",
      "approve",
      null,
    )).resolves.toBe("providerDetached");
    let decisionResponse: ReturnType<ScenarioGateway["handle"]> | undefined;
    const unsubscribe = runtime.subscribe(runId, (batch) => {
      if (
        decisionResponse === undefined &&
        batch.records.some((record) => record.eventType === "tool.authorization.userDecisionPending")
      ) {
        decisionResponse = gateway.handle({
          type: "request",
          requestId: "immediate-approval",
          payload: {
            operation: "submitToolDecision",
            runId,
            toolCallId: "tool-immediate",
            decision: "approve",
            reason: "approved immediately",
          },
        });
      }
    });

    await expect(authorizeTool?.({
      toolCallId: "tool-immediate",
      turnId: "turn-1",
      toolName: "Read",
      toolInput: { file_path: "README.md" },
      signal: new AbortController().signal,
    })).resolves.toEqual({ decision: "approve", reason: "approved immediately" });
    expect(decisionResponse).toBeDefined();
    await expect(decisionResponse).resolves.toMatchObject({ ok: true });
    unsubscribe();
    await manager.dispose();
  });

  it.each([
    { operation: "turn" as const, expectedRunStatus: "running" },
    { operation: "run" as const, expectedRunStatus: "cancelled" },
    { operation: "close" as const, expectedRunStatus: "closed" },
    { operation: "dispose" as const, expectedRunStatus: "cancelled" },
  ])("terminalizes waiting tool authorization on provider $operation cancellation", async ({
    operation,
    expectedRunStatus,
  }) => {
    const root = await createTemporaryTestRoot(roots, `scenario-provider-cancel-${operation}-`);
    const runtime = createTestScenarioRuntime({ root });
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider, authorizeTool): ProviderRunner => ({
        resolvedProvider,
        async *runTurn(input) {
          await authorizeTool({
            toolCallId: "tool-cancel",
            turnId: input.turnId,
            toolName: "Read",
            toolInput: { file_path: "private.txt" },
            signal: input.signal,
          });
        },
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });
    await manager.host.send(runId, "turn-cancel", "inspect");
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(runId)).toolCalls[0]?.status).toBe("waiting");
    });

    if (operation === "turn") await manager.host.cancel(runId, "turn-cancel");
    if (operation === "run") await manager.host.cancel(runId, null);
    if (operation === "close") await manager.host.close(runId);
    if (operation === "dispose") await manager.dispose();

    const snapshot = await runtime.snapshot(runId);
    expect(snapshot.status).toBe(expectedRunStatus);
    expect(snapshot.toolCalls[0]).toMatchObject({
      status: "cancelled",
      authorization: { final: "cancelled" },
    });
    expect(snapshot.toolCalls.some((tool) => ["requested", "waiting", "running"].includes(tool.status)))
      .toBe(false);
    await manager.dispose();
  });

  it("cancels independent provider authorization signals and releases the waiter identity", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-independent-authorization-");
    const runtime = createTestScenarioRuntime({ root });
    const authorizationSignals: AbortController[] = [];
    const authorizationAttempts: Array<Promise<unknown>> = [];
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider, authorizeTool): ProviderRunner => ({
        resolvedProvider,
        async *runTurn(input) {
          const independent = new AbortController();
          authorizationSignals.push(independent);
          const attempt = authorizeTool({
            toolCallId: "tool-independent-signal",
            turnId: input.turnId,
            toolName: "Read",
            toolInput: { file_path: "private.txt" },
            signal: independent.signal,
          });
          authorizationAttempts.push(attempt);
          await attempt;
        },
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });

    await manager.host.send(runId, "turn-independent-one", "inspect once");
    await vi.waitFor(async () => {
      expect(authorizationAttempts).toHaveLength(1);
      expect((await runtime.snapshot(runId)).toolCalls[0]?.status).toBe("waiting");
    });
    await manager.host.cancel(runId, "turn-independent-one");
    await expect(authorizationAttempts[0]).rejects.toThrow("Provider turn cancelled");
    expect(authorizationSignals[0]?.signal.aborted).toBe(false);

    await manager.host.send(runId, "turn-independent-two", "inspect again");
    await vi.waitFor(() => expect(authorizationAttempts).toHaveLength(2));
    const reusedIdentityError = await authorizationAttempts[1]?.then(
      () => null,
      (error: unknown) => error,
    );
    expect(reusedIdentityError).toMatchObject({ message: "Tool call already exists: tool-independent-signal" });
    expect(String(reusedIdentityError)).not.toContain("Authorization waiter already exists");
    expect(authorizationSignals[1]?.signal.aborted).toBe(false);
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(runId)).status).toBe("failed");
    });
    await manager.dispose();
  });

  it("terminalizes a waiting tool when its independent signal aborts during canonical dispatch", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-authorization-dispatch-abort-");
    const runtime = createTestScenarioRuntime({ root });
    let markDispatchEntered!: () => void;
    let releaseDispatch!: () => void;
    const dispatchEntered = new Promise<void>((resolve) => { markDispatchEntered = resolve; });
    const dispatchBarrier = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    let markCancellationDispatched!: () => void;
    const cancellationDispatched = new Promise<void>((resolve) => { markCancellationDispatched = resolve; });
    let markProviderDisposeEntered!: () => void;
    let releaseProviderDispose!: () => void;
    const providerDisposeEntered = new Promise<void>((resolve) => { markProviderDisposeEntered = resolve; });
    const providerDisposeBarrier = new Promise<void>((resolve) => { releaseProviderDispose = resolve; });
    const dispatch = runtime.dispatch.bind(runtime);
    vi.spyOn(runtime, "dispatch").mockImplementation(async (command) => {
      if (command.payload.type === "toolRequested" && command.payload.toolCallId === "tool-dispatch-abort") {
        markDispatchEntered();
        await dispatchBarrier;
      }
      const result = await dispatch(command);
      if (command.payload.type === "toolCancelled" && command.payload.toolCallId === "tool-dispatch-abort") {
        markCancellationDispatched();
      }
      return result;
    });
    const independent = new AbortController();
    let authorizationAttempt: Promise<unknown> | undefined;
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider, authorizeTool): ProviderRunner => ({
        resolvedProvider,
        async dispose() {
          markProviderDisposeEntered();
          await providerDisposeBarrier;
        },
        async *runTurn(input) {
          authorizationAttempt = authorizeTool({
            toolCallId: "tool-dispatch-abort",
            turnId: input.turnId,
            toolName: "Read",
            toolInput: { file_path: "private.txt" },
            signal: independent.signal,
          });
          await authorizationAttempt;
        },
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });

    await manager.host.send(runId, "turn-dispatch-abort", "inspect");
    await dispatchEntered;
    independent.abort();
    releaseDispatch();

    await expect(authorizationAttempt).rejects.toThrow("Tool authorization cancelled");
    await cancellationDispatched;
    expect((await runtime.snapshot(runId)).toolCalls).toMatchObject([{
      id: "tool-dispatch-abort",
      status: "cancelled",
      authorization: { final: "cancelled" },
    }]);
    expect((await runtime.snapshot(runId)).toolCalls.some((tool) =>
      ["requested", "waiting", "running"].includes(tool.status)
    )).toBe(false);
    await vi.waitFor(async () => {
      expect((await runtime.recordsAfter(runId, 0)).some((record) =>
        record.eventType === "runtime.error"
      )).toBe(true);
    });
    expect((await runtime.snapshot(runId)).status).toBe("running");
    await providerDisposeEntered;
    let managerDisposed = false;
    const managerDisposal = manager.dispose().then(() => { managerDisposed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(managerDisposed).toBe(false);
    releaseProviderDispose();
    await managerDisposal;
  }, 10_000);

  it("fences timed-out authorization terminalization after provider detachment", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-terminalization-fence-");
    const runtime = createTestScenarioRuntime({ root });
    const independent = new AbortController();
    let authorizationAttempt: Promise<unknown> | undefined;
    let releaseProvider!: () => void;
    const providerBarrier = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const manager = new ScenarioProviderManager({
      runtime,
      providerSettlementTimeoutMs: 20,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider, authorizeTool): ProviderRunner => ({
        resolvedProvider,
        dispose() {
          releaseProvider();
        },
        async *runTurn(input) {
          authorizationAttempt = authorizeTool({
            toolCallId: "tool-terminalization-fence",
            turnId: input.turnId,
            toolName: "Read",
            toolInput: { file_path: "private.txt" },
            signal: independent.signal,
          });
          try {
            await authorizationAttempt;
          } catch {
            await providerBarrier;
          }
        },
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });
    await manager.host.send(runId, "turn-terminalization-fence", "inspect");
    await vi.waitFor(async () => {
      expect(authorizationAttempt).toBeDefined();
      expect((await runtime.snapshot(runId)).toolCalls[0]?.status).toBe("waiting");
    });

    let markSnapshotEntered!: () => void;
    let releaseSnapshot!: () => void;
    const snapshotEntered = new Promise<void>((resolve) => { markSnapshotEntered = resolve; });
    const snapshotBarrier = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const snapshot = runtime.snapshot.bind(runtime);
    let blockNextSnapshot = true;
    vi.spyOn(runtime, "snapshot").mockImplementation(async (requestedRunId) => {
      const result = await snapshot(requestedRunId);
      if (blockNextSnapshot) {
        blockNextSnapshot = false;
        markSnapshotEntered();
        await snapshotBarrier;
      }
      return result;
    });

    independent.abort();
    await expect(authorizationAttempt).rejects.toThrow("Tool authorization cancelled");
    await snapshotEntered;
    await expect(manager.host.cancel(runId, null)).resolves.toBeUndefined();
    const recordsAtDetachment = await runtime.recordsAfter(runId, 0);
    const cancellationCount = recordsAtDetachment.filter((record) => record.eventType === "tool.cancelled").length;
    expect(cancellationCount).toBe(1);
    expect((await snapshot(runId)).recoveryDiagnostics).toContain(
      "Provider cleanup timed out while tearing down the provider run; provider detached",
    );

    releaseSnapshot();
    await vi.waitFor(async () => {
      expect((await runtime.recordsAfter(runId, 0)).filter((record) =>
        record.eventType === "tool.cancelled"
      )).toHaveLength(cancellationCount);
    });
    await manager.dispose();
  });

  it("rejects an independent authorization waiter during whole-run teardown", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-independent-run-teardown-");
    const runtime = createTestScenarioRuntime({ root });
    const independent = new AbortController();
    let authorizationAttempt: Promise<unknown> | undefined;
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider, authorizeTool): ProviderRunner => ({
        resolvedProvider,
        async *runTurn(input) {
          authorizationAttempt = authorizeTool({
            toolCallId: "tool-independent-run-teardown",
            turnId: input.turnId,
            toolName: "Read",
            toolInput: { file_path: "private.txt" },
            signal: independent.signal,
          });
          await authorizationAttempt;
        },
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });
    await manager.host.send(runId, "turn-independent-teardown", "inspect");
    await vi.waitFor(async () => {
      expect(authorizationAttempt).toBeDefined();
      expect((await runtime.snapshot(runId)).toolCalls[0]?.status).toBe("waiting");
    });

    await expect(manager.host.cancel(runId, null)).resolves.toBeUndefined();
    await expect(authorizationAttempt).rejects.toThrow("Provider run cancelled");
    expect(independent.signal.aborted).toBe(false);
    expect((await runtime.snapshot(runId)).status).toBe("cancelled");
    await expect(manager.host.close(runId)).rejects.toThrow("Unknown provider run");
  });

  it("reports real manager detachment after committing a canonical tool decision", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-detached-");
    const runtime = createTestScenarioRuntime({ root });
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn() {},
      }),
    });
    const runId = "detached-provider-run";
    const source = { kind: "providerSdk" as const, adapter: "claude", provider: "openrouter" };
    await runtime.dispatch(testStartRunCommand({
      commandId: "detached-start",
      runId,
      source,
      recordedAt: "2026-07-16T11:59:00.000Z",
      payload: {
        workingDir: root,
        projectDir: root,
        schemaDigest: scenarioProtocolSchemaDigest(),
        configuration: { provider: "openrouter" },
      },
    }));
    await runtime.dispatch({
      commandId: "detached-tool",
      runId,
      source,
      recordedAt: "2026-07-16T12:00:00.000Z",
      payload: {
        type: "toolRequested",
        toolCallId: "tool-detached",
        turnId: "turn-detached",
        name: "Read",
        input: { file_path: "README.md" },
        inputDigest: digestScenarioValue({ file_path: "README.md" }),
        requiresUserDecision: true,
      },
    });
    const gateway = new ScenarioGateway(runtime, { providerHost: manager.host });

    await expect(gateway.handle({
      type: "request",
      requestId: "detached-approval",
      payload: {
        operation: "submitToolDecision",
        runId,
        toolCallId: "tool-detached",
        decision: "approve",
        reason: null,
      },
    })).resolves.toMatchObject({
      ok: true,
      payload: {
        result: {
          status: "allowed",
          data: { providerCoordination: "providerDetached" },
        },
      },
    });
    expect((await runtime.snapshot(runId)).toolCalls[0]?.authorization.user).toBe("approved");
  });

  it("observes a secondary runtime-error persistence failure from a detached provider turn", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-background-error-");
    class FailingErrorPersistenceRuntime extends ScenarioRuntime {
      public override async dispatch(command: ScenarioCommand) {
        if (command.payload.type === "runtimeErrorObserved") {
          throw new Error("secondary runtime-error persistence failed");
        }
        return super.dispatch(command);
      }
    }
    const runtime = new FailingErrorPersistenceRuntime({ root });
    const backgroundErrors: Array<{ error: unknown; runId: string; turnId: string }> = [];
    const disposeFailedRunner = vi.fn();
    const manager = new ScenarioProviderManager({
      runtime,
      onBackgroundError: (error, context) => backgroundErrors.push({ error, ...context }),
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn() {
          throw new Error("primary provider failure");
        },
        dispose: disposeFailedRunner,
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });

    await manager.host.send(runId, "turn-background-1", "first");
    await vi.waitFor(() => expect(backgroundErrors).toHaveLength(1));
    expect(backgroundErrors[0]).toMatchObject({
      error: expect.objectContaining({ message: "secondary runtime-error persistence failed" }),
      runId,
      turnId: "turn-background-1",
    });
    expect(disposeFailedRunner).toHaveBeenCalledOnce();
    await expect(manager.host.send(runId, "turn-background-2", "second"))
      .rejects.toThrow(`Unknown provider run: ${runId}`);
    await manager.dispose();
  });

  it("observes aborted-turn terminal persistence failures and clears the turn reservation", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-cancel-persistence-");
    class FailingCancellationPersistenceRuntime extends ScenarioRuntime {
      public override async dispatch(command: ScenarioCommand) {
        if (command.payload.type === "assistantMessageCompleted") {
          throw new Error("cancel terminal persistence failed");
        }
        return super.dispatch(command);
      }
    }
    const runtime = new FailingCancellationPersistenceRuntime({ root });
    const backgroundErrors: unknown[] = [];
    let turnCount = 0;
    const manager = new ScenarioProviderManager({
      runtime,
      onBackgroundError: (error) => backgroundErrors.push(error),
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn(input) {
          turnCount += 1;
          if (turnCount > 1) return;
          await new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener("abort", () => reject(new Error("provider turn aborted")), { once: true });
          });
        },
      }),
    });
    const { runId } = await manager.host.start({
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    });
    await manager.host.send(runId, "turn-cancel-persistence", "first");
    await manager.host.cancel(runId, "turn-cancel-persistence");

    await vi.waitFor(() => expect(backgroundErrors).toHaveLength(1));
    expect(backgroundErrors[0]).toMatchObject({ message: "cancel terminal persistence failed" });
    await expect(manager.host.send(runId, "turn-after-persistence-failure", "second"))
      .resolves.toBeUndefined();
    await vi.waitFor(() => expect(turnCount).toBe(2));
    await manager.dispose();
  });

  it("clears provider entries even when runner disposal fails", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-dispose-failure-");
    const manager = new ScenarioProviderManager({
      runtime: createTestScenarioRuntime({ root }),
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn() {},
        dispose() {
          throw new Error("dispose failed");
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

    await expect(manager.dispose()).rejects.toThrow("Failed to dispose provider runs");
    await expect(manager.host.close(runId)).rejects.toThrow(`Unknown provider run: ${runId}`);
    await expect(manager.dispose()).resolves.toBeUndefined();
  });

  it("marks a partially started run failed and aggregates disposal errors", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-start-failure-");
    class FailingProviderStateRuntime extends ScenarioRuntime {
      public override async dispatch(command: ScenarioCommand) {
        if (command.payload.type === "providerStateObserved") throw new Error("provider metadata failed");
        return super.dispatch(command);
      }
    }
    const runtime = new FailingProviderStateRuntime({ root });
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn() {},
        dispose() { throw new Error("startup dispose failed"); },
      }),
    });

    let failure: unknown;
    try {
      await manager.host.start({
        model: null,
        workingDir: root,
        systemPrompt: null,
        continuable: false,
        sdkRuntimeEnvironment: "isolated",
        runtimeHome: { kind: "native", configuration: {} },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => String(error))).toEqual([
      "Error: provider metadata failed",
      "Error: startup dispose failed",
    ]);
    const [manifest] = await runtime.listRuns();
    expect(manifest?.status).toBe("failed");
    expect((await runtime.snapshot(manifest!.runId)).status).toBe("failed");
    await expect(manager.host.close(manifest!.runId)).rejects.toThrow("Unknown provider run");
  });

  it("marks a partially resumed run failed without losing the initialization error", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-resume-failure-");
    const source = { kind: "providerSdk" as const, adapter: "claude", provider: "openrouter" };
    const seedRuntime = createTestScenarioRuntime({ root });
    await seedRuntime.dispatch(testStartRunCommand({
      commandId: "resume-failure-start",
      runId: "resume-failure-run",
      source,
      recordedAt: "2026-07-15T12:00:00.000Z",
      payload: {
        workingDir: root,
        projectDir: root,
        schemaDigest: scenarioProtocolSchemaDigest(),
      },
    }));
    await seedRuntime.dispatch({
      commandId: "resume-failure-close",
      runId: "resume-failure-run",
      source,
      recordedAt: "2026-07-15T12:01:00.000Z",
      payload: { type: "closeRun" },
    });
    class FailingResumeMetadataRuntime extends ScenarioRuntime {
      public override async dispatch(command: ScenarioCommand) {
        if (command.payload.type === "providerStateObserved") throw new Error("resume metadata failed");
        return super.dispatch(command);
      }
    }
    const runtime = new FailingResumeMetadataRuntime({ root });
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createResumeRunner: (resolvedProvider): ProviderRunner => ({
        resolvedProvider,
        async *runTurn() {},
      }),
    });

    await expect(manager.host.resume("resume-failure-run", {
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    }, {
      sdkRuntime: "claude",
      nativeSessionId: "resume-native",
    })).rejects.toThrow("resume metadata failed");
    expect((await runtime.snapshot("resume-failure-run")).status).toBe("failed");
    await expect(manager.host.close("resume-failure-run")).rejects.toThrow("Unknown provider run");
  });

  it("resumes an existing canonical run through the provider SDK resume target", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-resume-");
    const runtime = createTestScenarioRuntime({ root });
    const source = { kind: "providerSdk" as const, adapter: "claude", provider: "openrouter" };
    await runtime.dispatch(testStartRunCommand({
      commandId: "start",
      runId: "provider-run",
      source,
      recordedAt: "2026-07-15T12:00:00.000Z",
      payload: {
        workingDir: root,
        projectDir: root,
        schemaDigest: scenarioProtocolSchemaDigest(),
      },
    }));
    await runtime.dispatch({
      commandId: "close",
      runId: "provider-run",
      source,
      recordedAt: "2026-07-15T12:01:00.000Z",
      payload: { type: "closeRun" },
    });

    const resumedTargets: unknown[] = [];
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createResumeRunner: (resolvedProvider, target): ProviderRunner => {
        resumedTargets.push(target);
        return {
          resolvedProvider,
          async *runTurn() {},
        };
      },
    });

    await expect(manager.host.resume("provider-run", {
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    }, {
      sdkRuntime: "claude",
      nativeSessionId: "native-resumed",
    })).resolves.toEqual({ runId: "provider-run" });

    expect(resumedTargets).toEqual([expect.objectContaining({
      sdkRuntime: "claude",
      nativeSessionId: "native-resumed",
    })]);
    const snapshot = await runtime.snapshot("provider-run");
    expect(snapshot.status).toBe("running");
    expect(snapshot.providerState.nativeSessionId).toBe("native-resumed");
    expect(snapshot.providerState.configurationTransition).toEqual({
      previous: null,
      current: {
        model: "test-model",
        systemPromptDigest: digestScenarioValue(null),
        sdkRuntimeEnvironment: "isolated",
      },
    });
    expect(snapshot.manifest.nativeSessionIds).toContain("native-resumed");
    expect((await runtime.recordsAfter("provider-run", 0)).some((record) =>
      record.eventType === "run.resumed"
    )).toBe(true);
    expect((await runtime.listRuns()).find((run) => run.runId === "provider-run")?.nativeSessionIds)
      .toContain("native-resumed");
    await manager.dispose();
  });

  it.each([
    {
      label: "a non-continuable configuration",
      continuable: false,
      workingDir: "canonical" as const,
      expected: "Provider resume requires a continuable session configuration",
    },
    {
      label: "a different working directory",
      continuable: true,
      workingDir: "different" as const,
      expected: "Provider resume working directory differs from the canonical run",
    },
  ])("rejects $label before resolving or constructing a resume runner", async ({
    continuable,
    workingDir,
    expected,
  }) => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-unsafe-resume-");
    const runtime = createTestScenarioRuntime({ root });
    const source = { kind: "providerSdk" as const, adapter: "claude", provider: "openrouter" };
    await runtime.dispatch(testStartRunCommand({
      commandId: "unsafe-resume-start",
      runId: "unsafe-resume-run",
      source,
      recordedAt: "2026-07-15T12:00:00.000Z",
      payload: {
        workingDir: root,
        projectDir: root,
        schemaDigest: scenarioProtocolSchemaDigest(),
      },
    }));
    await runtime.dispatch({
      commandId: "unsafe-resume-close",
      runId: "unsafe-resume-run",
      source,
      recordedAt: "2026-07-15T12:01:00.000Z",
      payload: { type: "closeRun" },
    });
    const beforeSnapshot = await runtime.snapshot("unsafe-resume-run");
    const beforeRecords = await runtime.recordsAfter("unsafe-resume-run", 0);
    const resolveProvider = vi.fn(() => testResolvedProvider({ sdkRuntime: "claude" }));
    const createResumeRunner = vi.fn((resolvedProvider: ResolvedProvider): ProviderRunner => ({
      resolvedProvider,
      async *runTurn() {},
    }));
    const manager = new ScenarioProviderManager({ runtime, resolveProvider, createResumeRunner });

    await expect(manager.host.resume("unsafe-resume-run", {
      model: null,
      workingDir: workingDir === "canonical" ? root : path.join(root, "different"),
      systemPrompt: null,
      continuable,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    }, {
      sdkRuntime: "claude",
      nativeSessionId: "unsafe-native",
    })).rejects.toThrow(expected);

    expect(resolveProvider).not.toHaveBeenCalled();
    expect(createResumeRunner).not.toHaveBeenCalled();
    expect(await runtime.snapshot("unsafe-resume-run")).toEqual(beforeSnapshot);
    expect(await runtime.recordsAfter("unsafe-resume-run", 0)).toEqual(beforeRecords);
    await manager.dispose();
  });

  it.each([
    {
      adapter: "claude" as const,
      nativeSessionId: "claude-native-resume",
    },
    {
      adapter: "codex" as const,
      nativeSessionId: "codex-native-resume",
    },
  ])("defaults an omitted $adapter resume directory and preserves its native target", async ({
    adapter,
    nativeSessionId,
  }) => {
    const root = await createTemporaryTestRoot(roots, `scenario-provider-${adapter}-resume-target-`);
    const runtime = createTestScenarioRuntime({ root });
    const runId = `${adapter}-resume-target-run`;
    const source = { kind: "providerSdk" as const, adapter, provider: "openrouter" };
    await runtime.dispatch(testStartRunCommand({
      commandId: `${adapter}-target-start`,
      runId,
      source,
      recordedAt: "2026-07-15T12:00:00.000Z",
      payload: {
        workingDir: root,
        projectDir: root,
        schemaDigest: scenarioProtocolSchemaDigest(),
      },
    }));
    await runtime.dispatch({
      commandId: `${adapter}-target-close`,
      runId,
      source,
      recordedAt: "2026-07-15T12:01:00.000Z",
      payload: { type: "closeRun" },
    });
    const resolveProvider = vi.fn((_config: ProviderSessionConfig) => testResolvedProvider({ sdkRuntime: adapter }));
    const resumedTargets: unknown[] = [];
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider,
      createResumeRunner: (resolvedProvider, resumeTarget): ProviderRunner => {
        resumedTargets.push(resumeTarget);
        return { resolvedProvider, async *runTurn() {} };
      },
    });

    await expect(manager.host.resume(runId, {
      model: null,
      workingDir: null,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    }, {
      sdkRuntime: adapter,
      nativeSessionId,
    })).resolves.toEqual({ runId });

    expect(resolveProvider).toHaveBeenCalledWith(expect.objectContaining({ workingDir: path.resolve(root) }));
    expect(resumedTargets).toEqual([expect.objectContaining({ sdkRuntime: adapter, nativeSessionId })]);
    const snapshot = await runtime.snapshot(runId);
    expect(snapshot.providerState.nativeSessionId).toBe(nativeSessionId);
    expect(snapshot.manifest.nativeSessionIds).toContain(nativeSessionId);
    await manager.dispose();
  });

  it("can resume a provider run after manager disposal terminalizes it", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-dispose-resume-");
    const runtime = createTestScenarioRuntime({ root });
    const resolvedProvider = testResolvedProvider({ sdkRuntime: "claude" });
    const firstManager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => resolvedProvider,
      createRunner: (resolved): ProviderRunner => ({ resolvedProvider: resolved, async *runTurn() {} }),
    });
    const config = {
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated" as const,
      runtimeHome: { kind: "native" as const, configuration: {} },
    };
    const { runId } = await firstManager.host.start(config);

    await firstManager.dispose();
    expect((await runtime.snapshot(runId)).status).toBe("cancelled");

    const createResumeRunner = vi.fn((resolved: ResolvedProvider): ProviderRunner => ({
      resolvedProvider: resolved,
      async *runTurn() {},
    }));
    const resumedManager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => resolvedProvider,
      createResumeRunner,
    });
    await expect(resumedManager.host.resume(runId, config, {
      sdkRuntime: "claude",
      nativeSessionId: "resumed-after-dispose",
    })).resolves.toEqual({ runId });

    expect(createResumeRunner).toHaveBeenCalledOnce();
    expect((await runtime.snapshot(runId)).status).toBe("running");
    await resumedManager.dispose();
  });

  it.each<{ label: string; source: RunSource; expected: string }>([
    {
      label: "a different adapter",
      source: { kind: "providerSdk", adapter: "codex", provider: "openrouter" },
      expected: "Persisted provider adapter is incompatible with resolved adapter claude",
    },
    {
      label: "a different provider",
      source: { kind: "providerSdk", adapter: "claude", provider: "claude-subscription" },
      expected: "Persisted provider identity is incompatible with resolved provider openrouter",
    },
    {
      label: "a host hook",
      source: { kind: "hostHook", adapter: "claude", nativeSessionId: "hook-session" },
      expected: "Cannot resume non-provider Scenario run",
    },
    {
      label: "a scenario fixture",
      source: { kind: "scenarioFixture" },
      expected: "Cannot resume non-provider Scenario run",
    },
  ])("rejects resuming a persisted run created by $label before constructing a runner", async ({
    source,
    expected,
  }) => {
    const root = await createTemporaryTestRoot(roots, "scenario-provider-incompatible-resume-");
    const runtime = createTestScenarioRuntime({ root });
    const runId = "persisted-run";
    await runtime.dispatch(testStartRunCommand({
      commandId: "persisted-start",
      runId,
      source,
      recordedAt: "2026-07-15T12:00:00.000Z",
      payload: {
        workingDir: root,
        projectDir: root,
        schemaDigest: scenarioProtocolSchemaDigest(),
      },
    }));
    await runtime.dispatch({
      commandId: "persisted-close",
      runId,
      source,
      recordedAt: "2026-07-15T12:01:00.000Z",
      payload: { type: "closeRun" },
    });
    const beforeSnapshot = await runtime.snapshot(runId);
    const beforeRecords = await runtime.recordsAfter(runId, 0);
    const createResumeRunner = vi.fn((resolvedProvider: ResolvedProvider): ProviderRunner => ({
      resolvedProvider,
      async *runTurn() {},
    }));
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createResumeRunner,
    });

    await expect(manager.host.resume(runId, {
      model: null,
      workingDir: root,
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
      runtimeHome: { kind: "native", configuration: {} },
    }, {
      sdkRuntime: "claude",
      nativeSessionId: "native-resumed",
    })).rejects.toThrow(expected);

    expect(createResumeRunner).not.toHaveBeenCalled();
    expect(await runtime.snapshot(runId)).toEqual(beforeSnapshot);
    expect(await runtime.recordsAfter(runId, 0)).toEqual(beforeRecords);
    await manager.dispose();
  });
});
