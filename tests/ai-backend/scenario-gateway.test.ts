import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenarioGateway } from "../../src/ai-backend/gateway.js";
import { ScenarioProviderManager } from "../../src/ai-backend/scenario-provider-manager.js";
import type { ProviderRunner } from "../../src/ai-backend/provider.js";
import { RulePipelineEffectExecutor } from "../../src/effects/rule-pipeline-executor.js";
import {
  providerRunConfigSchema,
  scenarioGatewayOperationScopes,
  type ScenarioGatewayRequest,
  type ScenarioGatewayEvent,
  type ScenarioCommand,
} from "../../src/scenario/protocol/index.js";
import { digestScenarioValue } from "../../src/scenario/protocol/digest.js";
import { scenarioProtocolSchemaDigest } from "../../src/scenario/protocol/schema.js";
import { createTestScenarioRuntime } from "../helpers/scenario-runtime.js";
import {
  testResolvedProvider,
  testStartRunCommand,
} from "../helpers/scenario-fixtures.js";
import {
  cleanupTemporaryTestRoots,
  createTemporaryTestRoot,
} from "../helpers/temporary-root.js";

const roots: string[] = [];

afterEach(async () => {
  await cleanupTemporaryTestRoots(roots);
});

describe("ScenarioGateway", () => {
  it("keeps provider runtime policy opaque at the generic gateway boundary", () => {
    expect(providerRunConfigSchema.safeParse({
      model: null,
      workingDir: null,
      systemPrompt: null,
      continuable: false,
      sdkRuntimeEnvironment: "third-party-environment",
      runtimeHome: { kind: "third-party-home", configuration: { profile: "consumer-owned" } },
    }).success).toBe(true);
  });

  it("enforces the protocol-owned scope mapping for every gateway operation", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-scopes-");
    const gateway = new ScenarioGateway(createTestScenarioRuntime({ root }), {
      authority: { scopes: [], visibilityScope: ["public"] },
    });
    const providerConfig = {
      model: null,
      workingDir: null,
      systemPrompt: null,
      continuable: false,
      sdkRuntimeEnvironment: "isolated" as const,
      runtimeHome: { kind: "native" as const, configuration: {} },
    };
    const requests: ScenarioGatewayRequest["payload"][] = [
      { operation: "listRuns" },
      { operation: "startProviderRun", config: providerConfig },
      {
        operation: "resumeProviderRun",
        runId: "run-1",
        config: providerConfig,
        target: {
          sdkRuntime: "claude",
          nativeSessionId: "native-1",
        },
      },
      { operation: "sendConversationInput", runId: "run-1", turnId: "turn-1", input: "hello" },
      { operation: "cancelProviderTurn", runId: "run-1", turnId: null },
      { operation: "closeProviderRun", runId: "run-1" },
      { operation: "attachRun", runId: "run-1" },
      { operation: "getSnapshot", runId: "run-1" },
      { operation: "recordsAfter", runId: "run-1", afterSeq: 0 },
      { operation: "subscribe", runId: "run-1", afterSeq: 0 },
      { operation: "unsubscribe", runId: "run-1" },
      {
        operation: "dispatch",
        command: {
          commandId: "command-1",
          runId: "run-1",
          source: { kind: "gateway" },
          recordedAt: "2026-07-16T12:00:00.000Z",
          payload: { type: "closeRun" },
        },
      },
      {
        operation: "submitToolDecision",
        runId: "run-1",
        toolCallId: "tool-1",
        decision: "approve",
        reason: null,
      },
      {
        operation: "submitFeedback",
        runId: "run-1",
        targetKind: "assistantMessage",
        targetId: "message-1",
        vote: "up",
        idempotencyKey: "feedback-1",
        targetRecordSeq: 1,
      },
      {
        operation: "fetchArtifact",
        runId: "run-1",
        artifact: {
          artifactId: "a".repeat(64),
          digest: `sha256:${"a".repeat(64)}`,
          byteLength: 1,
          mediaType: "application/octet-stream",
          visibility: "public",
        },
      },
    ];
    expect(requests.map((payload) => payload.operation).sort())
      .toEqual(Object.keys(scenarioGatewayOperationScopes).sort());

    for (const [index, payload] of requests.entries()) {
      await expect(gateway.handle({
        type: "request",
        requestId: `scope-${index}`,
        payload,
      })).resolves.toMatchObject({
        ok: false,
        payload: {
          code: "permission_denied",
          message: `Missing gateway scope: ${scenarioGatewayOperationScopes[payload.operation]}`,
        },
      });
    }
  });

  it("rejects an interior records cursor and replays the whole preceding committed batch", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-record-cursor-");
    const runtime = createTestScenarioRuntime({ root });
    await runtime.dispatch(testStartRunCommand({
      runId: "record-cursor-run",
      commandId: "record-cursor-start",
      payload: { schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    const [firstBatch] = await runtime.committedBatchesAfter("record-cursor-run", 0);
    expect(firstBatch.records.length).toBeGreaterThan(1);
    const gateway = new ScenarioGateway(runtime);

    await expect(gateway.handle({
      type: "request",
      requestId: "interior-record-cursor",
      payload: {
        operation: "recordsAfter",
        runId: "record-cursor-run",
        afterSeq: firstBatch.fromSeq,
      },
    })).resolves.toMatchObject({
      ok: false,
      payload: { code: "cursor_gap" },
    });

    await expect(gateway.handle({
      type: "request",
      requestId: "preceding-record-cursor",
      payload: { operation: "recordsAfter", runId: "record-cursor-run", afterSeq: 0 },
    })).resolves.toMatchObject({
      ok: true,
      payload: { kind: "records", records: firstBatch.records },
    });
  });

  it("confines generic dispatch to gateway-owned run lifecycles", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-ownership-");
    const runtime = createTestScenarioRuntime({ root });
    const gateway = new ScenarioGateway(runtime);
    const startPayload = testStartRunCommand({ payload: { schemaDigest: scenarioProtocolSchemaDigest() } }).payload;
    const owners = [
      { runId: "provider-owned", source: { kind: "providerSdk" as const, provider: "test" } },
      { runId: "hook-owned", source: { kind: "hostHook" as const, adapter: "codex" } },
      { runId: "fixture-owned", source: { kind: "scenarioFixture" as const } },
    ];
    for (const { runId, source } of owners) {
      await runtime.dispatch({
        commandId: `start-${runId}`,
        runId,
        source,
        recordedAt: "2026-07-16T12:00:00.000Z",
        payload: startPayload,
      });
    }
    const blockedPayloads: ScenarioCommand["payload"][] = [
      {
        type: "userMessageSubmitted",
        messageId: "message-1",
        turnId: "turn-1",
        content: "blocked cross-owner input",
        contentDigest: digestScenarioValue("blocked cross-owner input"),
      },
      { type: "planStateChanged", data: { mode: "planning" } },
      { type: "closeRun" },
    ];
    for (const { runId, source } of owners) {
      const before = await runtime.snapshot(runId);
      for (const [index, payload] of blockedPayloads.entries()) {
        await expect(gateway.handle({
          type: "request",
          requestId: `blocked-${runId}-${index}`,
          payload: {
            operation: "dispatch",
            command: {
              commandId: `blocked-command-${runId}-${index}`,
              runId,
              source: { kind: "gateway" },
              recordedAt: "2026-07-16T12:01:00.000Z",
              payload,
            },
          },
        })).resolves.toMatchObject({
          ok: false,
          payload: {
            kind: "error",
            code: "permission_denied",
            message: `Gateway dispatch cannot mutate ${source.kind}-owned run: ${runId}`,
          },
        });
      }
      expect(await runtime.snapshot(runId)).toEqual(before);
    }

    await expect(gateway.handle({
      type: "request",
      requestId: "gateway-start",
      payload: {
        operation: "dispatch",
        command: {
          commandId: "gateway-start-command",
          runId: "gateway-owned",
          source: { kind: "scenarioFixture" },
          recordedAt: "2026-07-16T12:00:00.000Z",
          payload: startPayload,
        },
      },
    })).resolves.toMatchObject({ ok: true });
    for (const [index, payload] of blockedPayloads.entries()) {
      await expect(gateway.handle({
        type: "request",
        requestId: `gateway-command-${index}`,
        payload: {
          operation: "dispatch",
          command: {
            commandId: `gateway-owned-command-${index}`,
            runId: "gateway-owned",
            source: { kind: "hostHook" },
            recordedAt: "2026-07-16T12:01:00.000Z",
            payload,
          },
        },
      })).resolves.toMatchObject({ ok: true });
    }
    expect((await runtime.snapshot("gateway-owned")).manifest.source.kind).toBe("gateway");
    expect((await runtime.snapshot("gateway-owned")).status).toBe("closed");
  });

  it("preserves stable error codes for stale tool decisions and feedback targets", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-stale-conflicts-");
    const runtime = createTestScenarioRuntime({ root });
    const base = {
      runId: "stale-conflict-run",
      source: { kind: "gateway" as const },
      recordedAt: "2026-07-16T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "start",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    const input = { command: "pwd" };
    await runtime.dispatch({ ...base, commandId: "tool", payload: {
      type: "toolRequested",
      toolCallId: "stale-tool",
      turnId: null,
      name: "Bash",
      input,
      inputDigest: digestScenarioValue(input),
      requiresUserDecision: true,
    } });
    const content = "Stable feedback target";
    await runtime.dispatch({ ...base, commandId: "message", payload: {
      type: "assistantMessageCompleted",
      messageId: "stale-message",
      turnId: null,
      content,
      contentDigest: digestScenarioValue(content),
    } });
    const gateway = new ScenarioGateway(runtime);

    await expect(gateway.handle({
      type: "request",
      requestId: "stale-tool-decision",
      payload: {
        operation: "submitToolDecision",
        runId: base.runId,
        toolCallId: "stale-tool",
        decision: "approve",
        reason: null,
        expectedSnapshotRevision: 0,
      },
    })).resolves.toMatchObject({
      ok: false,
      payload: {
        kind: "error",
        code: "snapshot_revision_conflict",
        message: expect.stringContaining("Snapshot revision conflict"),
      },
    });
    await expect(gateway.handle({
      type: "request",
      requestId: "stale-feedback-target",
      payload: {
        operation: "submitFeedback",
        runId: base.runId,
        targetKind: "assistantMessage",
        targetId: "stale-message",
        vote: "up",
        idempotencyKey: "stale-feedback",
        expectedTargetDigest: `sha256:${"0".repeat(64)}`,
      },
    })).resolves.toMatchObject({
      ok: false,
      payload: {
        kind: "error",
        code: "feedback_target_conflict",
        message: "Feedback target digest is stale",
      },
    });
  });

  it("lists and attaches to runs without adapter-specific knowledge", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-");
    let generated = 0;
    const runtime = createTestScenarioRuntime({ root, idFactory: () => `generated-${++generated}` });
    const start: ScenarioCommand = testStartRunCommand({
      commandId: "start",
      runId: "hook-run",
      source: { kind: "hostHook", adapter: "codex", nativeSessionId: "native-1" },
      recordedAt: "2026-07-15T12:00:00.000Z",
      payload: { schemaDigest: scenarioProtocolSchemaDigest() },
    });
    await runtime.dispatch(start);
    const gateway = new ScenarioGateway(runtime);

    const listed = await gateway.handle({
      type: "request",
      requestId: "list",
      payload: { operation: "listRuns" },
    });
    expect(listed).toMatchObject({
      ok: true,
      payload: { kind: "runs", runs: [{ runId: "hook-run", source: { kind: "hostHook", adapter: "codex" } }] },
    });
    const attached = await gateway.handle({
      type: "request",
      requestId: "attach",
      payload: { operation: "attachRun", runId: "hook-run" },
    });
    expect(attached).toMatchObject({
      ok: true,
      payload: { kind: "attached", cursor: 9, snapshot: { runId: "hook-run", lastRecordSeq: 9 } },
    });
  });

  it("routes provider conversation operations through the canonical provider host", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-provider-");
    const runtime = createTestScenarioRuntime({ root });
    const calls: unknown[] = [];
    const gateway = new ScenarioGateway(runtime, {
      providerHost: {
        async start(config) {
          calls.push(["start", config]);
          return { runId: "provider-run" };
        },
        async resume(runId, config, target) {
          calls.push(["resume", runId, config, target]);
          return { runId };
        },
        async send(runId, turnId, input) {
          calls.push(["send", runId, turnId, input]);
        },
        async cancel(runId, turnId) {
          calls.push(["cancel", runId, turnId]);
        },
        async close(runId) {
          calls.push(["close", runId]);
        },
      },
    });
    const resumed = await gateway.handle({
      type: "request",
      requestId: "resume-provider",
      payload: {
        operation: "resumeProviderRun",
        runId: "existing-provider-run",
        config: {
          model: null,
          workingDir: "/workspace",
          systemPrompt: null,
          continuable: true,
          sdkRuntimeEnvironment: "isolated",
          runtimeHome: { kind: "managed", configuration: { profile: "default" } },
        },
        target: {
          sdkRuntime: "claude",
          nativeSessionId: "native-1",
        },
      },
    });

    const started = await gateway.handle({
      type: "request",
      requestId: "start-provider",
      payload: {
        operation: "startProviderRun",
        config: {
          model: null,
          workingDir: "/workspace",
          systemPrompt: null,
          continuable: true,
          sdkRuntimeEnvironment: "isolated",
          runtimeHome: { kind: "managed", configuration: { profile: "default" } },
        },
      },
    });
    await gateway.handle({
      type: "request",
      requestId: "send",
      payload: { operation: "sendConversationInput", runId: "provider-run", turnId: "turn-1", input: "hello" },
    });
    await gateway.handle({
      type: "request",
      requestId: "cancel",
      payload: { operation: "cancelProviderTurn", runId: "provider-run", turnId: "turn-1" },
    });
    await gateway.handle({
      type: "request",
      requestId: "close",
      payload: { operation: "closeProviderRun", runId: "provider-run" },
    });

    expect(started).toMatchObject({ ok: true, payload: { kind: "accepted", result: { runId: "provider-run" } } });
    expect(resumed).toMatchObject({
      ok: true,
      payload: { kind: "accepted", result: { runId: "existing-provider-run" } },
    });
    expect(calls).toEqual([
      [
        "resume",
        "existing-provider-run",
        expect.objectContaining({ runtimeHome: { kind: "managed", configuration: { profile: "default" } } }),
        expect.objectContaining({ sdkRuntime: "claude", nativeSessionId: "native-1" }),
      ],
      ["start", expect.objectContaining({ runtimeHome: { kind: "managed", configuration: { profile: "default" } } })],
      ["send", "provider-run", "turn-1", "hello"],
      ["cancel", "provider-run", "turn-1"],
      ["close", "provider-run"],
    ]);
  });

  it("enforces trusted scopes and authors feedback from transport authority", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-authority-");
    let generated = 0;
    const runtime = createTestScenarioRuntime({ root, idFactory: () => `authority-${++generated}` });
    const base = {
      runId: "authority-run",
      source: { kind: "providerSdk" as const, provider: "test" },
      recordedAt: "2026-07-15T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "start",
      payload: { schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    const content = "Completed response";
    await runtime.dispatch({
      ...base,
      commandId: "assistant",
      payload: {
        type: "assistantMessageCompleted",
        messageId: "message-1",
        turnId: "turn-1",
        content,
        contentDigest: digestScenarioValue(content),
      },
    });
    const readOnly = new ScenarioGateway(runtime, {
      authority: {
        subjectId: "passkey-user-7",
        clientId: "astral-server",
        clientVersion: "7",
        scopes: ["run.read", "feedback.write"],
        visibilityScope: ["public"],
      },
    });

    expect(await readOnly.handle({
      type: "request",
      requestId: "forbidden-list",
      payload: { operation: "listRuns" },
    })).toMatchObject({ ok: false, payload: { code: "permission_denied" } });
    const firstFeedbackRequest = {
      operation: "submitFeedback" as const,
      runId: "authority-run",
      targetKind: "assistantMessage" as const,
      targetId: "message-1",
      vote: "up" as const,
      note: "Useful",
      idempotencyKey: "authority-feedback-1",
      expectedTargetDigest: digestScenarioValue(content),
    };
    const firstFeedbackResponse = await readOnly.handle({
      type: "request",
      requestId: "feedback",
      payload: firstFeedbackRequest,
    });
    expect(firstFeedbackResponse).toMatchObject({
      ok: true,
      payload: {
        kind: "accepted",
        result: {
          vote: "up",
          author: { subjectId: "passkey-user-7" },
        },
      },
    });
    if (!firstFeedbackResponse.ok || firstFeedbackResponse.payload.kind !== "accepted") {
      throw new Error("Expected the first feedback submission to be accepted");
    }
    const firstFeedback = firstFeedbackResponse.payload.result as { feedbackId: string };
    await expect(readOnly.handle({
      type: "request",
      requestId: "feedback-superseding",
      payload: {
        ...firstFeedbackRequest,
        vote: "down",
        note: "Superseding feedback",
        idempotencyKey: "authority-feedback-2",
      },
    })).resolves.toMatchObject({ ok: true, payload: { result: { vote: "down" } } });
    await expect(readOnly.handle({
      type: "request",
      requestId: "feedback-original-retry",
      payload: firstFeedbackRequest,
    })).resolves.toMatchObject({
      ok: true,
      payload: {
        result: {
          feedbackId: firstFeedback.feedbackId,
          vote: "up",
          note: "Useful",
          supersedesFeedbackId: null,
        },
      },
    });

    expect(Object.values((await runtime.snapshot("authority-run")).feedback)[0]).toMatchObject({
      vote: "down",
      author: {
        subjectId: "passkey-user-7",
        clientId: "astral-server",
        clientVersion: "7",
      },
    });
  });

  it("redacts local rule and command state from public projections", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-visibility-");
    const runtime = createTestScenarioRuntime({
      root,
      maximumInlineBytes: 32,
      redactionPaths: ["runtimeHome.configuration.privateCachePath"],
      effectExecutor: new RulePipelineEffectExecutor({
        rules: [{
          name: "visibility-deny",
          displayName: "Visibility deny",
          priority: 1,
          appealable: false,
          usesLlm: false,
          version: "1",
          configuration: {},
          promptSection: "",
          async check() {
            return { fastDeny: "private policy reason" };
          },
        }],
      }),
    });
    const base = {
      runId: "visibility-run",
      source: {
        kind: "providerSdk" as const,
        adapter: "claude",
        provider: "private-provider",
        nativeSessionId: "private-native-session",
      },
      recordedAt: "2026-07-15T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "visibility-start",
      payload: {
        schemaDigest: scenarioProtocolSchemaDigest(),
        configuration: {
          api_key: "private-config-secret",
          cachePath: "/private/runtime/cache",
        },
        runtimeHome: {
          kind: "consumerOwned",
          configuration: {
            apiToken: "private-runtime-home-token",
            privateCachePath: "/private/runtime-home/cache",
            profile: "consumer-profile",
          },
        },
      },
    }));
    const sensitiveArtifactPreview = "private-action-preview-must-not-leak".repeat(4);
    const input = { command: sensitiveArtifactPreview };
    await runtime.dispatch({
      ...base,
      commandId: "visibility-tool",
      payload: {
        type: "toolRequested",
        toolCallId: "visibility-tool-1",
        turnId: null,
        name: "Bash",
        input,
        inputDigest: digestScenarioValue(input),
        requiresUserDecision: false,
      },
    });
    const privateMessage = "private assistant response";
    await runtime.dispatch({
      ...base,
      commandId: "visibility-message",
      payload: {
        type: "assistantMessageCompleted",
        messageId: "visibility-message-1",
        turnId: "visibility-turn-1",
        content: privateMessage,
        contentDigest: digestScenarioValue(privateMessage),
      },
    });
    await runtime.dispatch({
      ...base,
      commandId: "visibility-provider-state",
      payload: { type: "providerStateObserved", data: { token: "private-provider-state" } },
    });
    await runtime.dispatch({
      ...base,
      commandId: "visibility-plan-state",
      payload: { type: "planStateChanged", data: { path: "/private/plan.md" } },
    });
    await runtime.dispatch({
      ...base,
      commandId: "visibility-continuation-state",
      payload: { type: "continuationStateChanged", data: { sessionId: "private-continuation" } },
    });
    await runtime.dispatch({
      ...base,
      commandId: "visibility-feedback",
      payload: {
        type: "submitFeedback",
        targetKind: "assistantMessage",
        targetId: "visibility-message-1",
        vote: "up",
        note: "private feedback note",
        idempotencyKey: "visibility-feedback-1",
        expectedTargetDigest: digestScenarioValue(privateMessage),
        author: { subjectId: "private-user", clientId: "private-client", clientVersion: "1" },
      },
    });
    await runtime.dispatch({
      ...base,
      commandId: "visibility-error",
      payload: {
        type: "runtimeErrorObserved",
        data: { message: "private runtime error", recoverable: true },
      },
    });
    expect(JSON.stringify((await runtime.snapshot("visibility-run")).manifest.configuration))
      .not.toContain("private-config-secret");
    const canonicalRuntimeHome = (await runtime.snapshot("visibility-run")).manifest.runtimeHome;
    expect(JSON.stringify(canonicalRuntimeHome)).not.toContain("private-runtime-home-token");
    expect(JSON.stringify(canonicalRuntimeHome)).not.toContain("/private/runtime-home/cache");
    expect(canonicalRuntimeHome.configuration).not.toEqual({});
    const events: unknown[] = [];
    const gateway = new ScenarioGateway(runtime, {
      authority: {
        scopes: ["run.list", "run.read"],
        visibilityScope: ["public"],
      },
      emit: (event) => events.push(event),
    });

    const listed = await gateway.handle({
      type: "request",
      requestId: "public-list",
      payload: { operation: "listRuns" },
    });
    expect(listed).toMatchObject({
      ok: true,
      payload: {
        runs: [{
          runId: "visibility-run",
          source: { kind: "providerSdk" },
          workingDir: null,
        }],
      },
    });
    const snapshotResponse = await gateway.handle({
      type: "request",
      requestId: "public-snapshot",
      payload: { operation: "getSnapshot", runId: "visibility-run" },
    });
    expect(snapshotResponse).toMatchObject({
      ok: true,
      payload: {
        snapshot: {
          identity: { workingDir: null, projectDir: null },
          manifest: {
            source: { kind: "providerSdk" },
            adapter: null,
            provider: null,
            nativeSessionIds: [],
            runtimeHome: { kind: "consumerOwned", configuration: {} },
            configuration: {},
          },
          commandResults: {},
          providerState: {},
          plan: {},
          continuation: {},
          stateSlices: {},
          effects: [],
          feedback: {},
          errors: [],
          recoveryDiagnostics: [],
          toolCalls: [{ authorization: { reason: "[redacted]" } }],
        },
      },
    });
    const attached = await gateway.handle({
      type: "request",
      requestId: "public-attach",
      payload: { operation: "attachRun", runId: "visibility-run" },
    });
    expect(attached).toMatchObject({
      ok: true,
      payload: {
        snapshot: {
          manifest: { runtimeHome: { kind: "consumerOwned", configuration: {} } },
        },
      },
    });
    const recordsResponse = await gateway.handle({
      type: "request",
      requestId: "public-records",
      payload: { operation: "recordsAfter", runId: "visibility-run", afterSeq: 0 },
    });
    expect(JSON.stringify(recordsResponse)).not.toContain("private policy reason");
    expect(JSON.stringify(recordsResponse)).not.toContain(sensitiveArtifactPreview.slice(0, 32));
    expect(recordsResponse).toMatchObject({ ok: true });
    if (recordsResponse.ok && recordsResponse.payload.kind === "records") {
      const artifactLinks = recordsResponse.payload.records
        .filter((record) => record.eventType === "artifact.linked");
      expect(artifactLinks.length).toBeGreaterThan(0);
      expect(artifactLinks.every((record) => {
        const artifact = record.payload.artifact;
        return typeof artifact === "object" && artifact !== null && !("preview" in artifact);
      })).toBe(true);
    }
    const restrictedProjection = JSON.stringify([listed, snapshotResponse, attached, recordsResponse]);
    for (const sensitive of [
      "/workspace",
      "/private/runtime/cache",
      "/private/runtime-home/cache",
      "private-runtime-home-token",
      "consumer-profile",
      "/private/plan.md",
      "private-native-session",
      "private-provider",
      "private-provider-state",
      "private-continuation",
      "private feedback note",
      "private runtime error",
      "private assistant response",
      "private-user",
      "private-client",
    ]) {
      expect(restrictedProjection).not.toContain(sensitive);
    }

    const cursor = (await runtime.snapshot("visibility-run")).lastRecordSeq;
    await gateway.handle({
      type: "request",
      requestId: "public-subscribe",
      payload: { operation: "subscribe", runId: "visibility-run", afterSeq: cursor },
    });
    await runtime.dispatch({
      ...base,
      commandId: "visibility-subscription-plan",
      payload: { type: "planStateChanged", data: { secret: "private-subscription-state" } },
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("private-subscription-state");
    expect(JSON.stringify(events)).not.toContain("visibility-subscription-plan");
    await gateway.dispose();
  });

  it("keeps gateway subscriptions contiguous when another runtime subscriber fails", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-subscriber-failure-");
    let generated = 0;
    const runtime = createTestScenarioRuntime({ root, idFactory: () => `subscriber-diagnostic-${++generated}` });
    const base = {
      runId: "subscriber-gateway-run",
      source: { kind: "scenarioFixture" as const },
      recordedAt: "2026-07-15T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "subscriber-gateway-start",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    runtime.subscribe(base.runId, () => { throw new Error("broken observer"); });
    const events: ScenarioGatewayEvent[] = [];
    const gateway = new ScenarioGateway(runtime, { emit: (event) => events.push(event) });
    const cursor = (await runtime.snapshot(base.runId)).lastRecordSeq;
    await gateway.handle({
      type: "request",
      requestId: "subscribe-after-start",
      payload: { operation: "subscribe", runId: base.runId, afterSeq: cursor },
    });

    await runtime.dispatch({
      ...base,
      commandId: "subscriber-gateway-plan",
      payload: { type: "planStateChanged", data: { step: 1 } },
    });
    await runtime.dispatch({
      ...base,
      commandId: "subscriber-gateway-continuation",
      payload: { type: "continuationStateChanged", data: { step: 2 } },
    });

    expect(events.some((event) => event.type === "resyncRequired")).toBe(false);
    const batches = events.flatMap((event) => event.type === "eventBatch" ? [event.batch] : []);
    expect(batches.some((batch) => batch.records.some((record) =>
      record.eventType === "store.diagnostic"
    ))).toBe(true);
    for (let index = 1; index < batches.length; index += 1) {
      expect(batches[index]?.fromSeq).toBe((batches[index - 1]?.toSeq ?? 0) + 1);
    }
    await gateway.dispose();
  });

  it("preserves a valid subscription when a replacement cursor is rejected", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-rejected-resubscribe-");
    const runtime = createTestScenarioRuntime({ root });
    const base = {
      runId: "rejected-resubscribe-run",
      source: { kind: "scenarioFixture" as const },
      recordedAt: "2026-07-15T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "rejected-resubscribe-start",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    const events: ScenarioGatewayEvent[] = [];
    const gateway = new ScenarioGateway(runtime, { emit: (event) => events.push(event) });
    const cursor = (await runtime.snapshot(base.runId)).lastRecordSeq;
    await expect(gateway.handle({
      type: "request",
      requestId: "valid-subscription",
      payload: { operation: "subscribe", runId: base.runId, afterSeq: cursor },
    })).resolves.toMatchObject({ ok: true });

    await expect(gateway.handle({
      type: "request",
      requestId: "invalid-replacement",
      payload: { operation: "subscribe", runId: base.runId, afterSeq: cursor + 1 },
    })).resolves.toMatchObject({
      ok: false,
      payload: { code: "cursor_gap" },
    });
    await runtime.dispatch({
      ...base,
      commandId: "after-rejected-resubscribe",
      payload: { type: "planStateChanged", data: { step: "still subscribed" } },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "eventBatch",
      batch: { fromSeq: cursor + 1 },
    });
    expect(events[0]?.type === "eventBatch" && events[0].batch.records.every((record) =>
      record.commandId === "after-rejected-resubscribe"
    )).toBe(true);
    await gateway.dispose();
  });

  it("stops a subscription after emitting a cursor-gap resync notice", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-gap-");
    const runtime = createTestScenarioRuntime({ root });
    const base = {
      runId: "gap-run",
      source: { kind: "scenarioFixture" as const },
      recordedAt: "2026-07-15T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "gap-start",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    const cursor = (await runtime.snapshot(base.runId)).lastRecordSeq;
    vi.spyOn(runtime, "committedBatchesAfter").mockResolvedValueOnce([{
      runId: base.runId,
      fromSeq: cursor + 2,
      toSeq: cursor + 2,
      baseSnapshotRevision: 1,
      resultingSnapshotRevision: 2,
      records: [{
        runId: base.runId,
        recordSeq: cursor + 2,
        recordId: "gap-record",
        recordedAt: base.recordedAt,
        commandId: "gap-command",
        eventType: "runtime.error",
        visibility: "localSensitive",
        payload: { message: "gap" },
      }],
    }]);
    const events: ScenarioGatewayEvent[] = [];
    const gateway = new ScenarioGateway(runtime, { emit: (event) => events.push(event) });

    await expect(gateway.handle({
      type: "request",
      requestId: "gap-subscribe",
      payload: { operation: "subscribe", runId: base.runId, afterSeq: cursor },
    })).resolves.toMatchObject({ ok: true });
    expect(events).toEqual([expect.objectContaining({
      type: "resyncRequired",
      runId: base.runId,
      expectedNextSeq: cursor + 1,
      receivedFromSeq: cursor + 2,
    })]);

    await runtime.dispatch({
      ...base,
      commandId: "after-gap",
      payload: { type: "planStateChanged", data: { step: "must not stream" } },
    });
    expect(events).toHaveLength(1);
    await gateway.dispose();
  });

  it("reports invalid projected batches and requires a subscription resync", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-invalid-projection-");
    const runtime = createTestScenarioRuntime({ root });
    const runId = "invalid-projection-run";
    await runtime.dispatch(testStartRunCommand({
      runId,
      commandId: "invalid-projection-start",
      payload: { schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    const snapshot = await runtime.snapshot(runId);
    const cursor = snapshot.lastRecordSeq;
    vi.spyOn(runtime, "committedBatchesAfter").mockResolvedValueOnce([{
      runId,
      fromSeq: cursor + 1,
      toSeq: cursor + 1,
      baseSnapshotRevision: snapshot.revision,
      resultingSnapshotRevision: snapshot.revision + 1,
      records: [{
        runId,
        recordSeq: cursor + 1,
        recordId: "invalid-projection-record",
        recordedAt: "not-a-timestamp",
        commandId: "invalid-projection-command",
        eventType: "runtime.error",
        visibility: "public",
        payload: { message: "invalid projection" },
      }],
    }] as never);
    const events: ScenarioGatewayEvent[] = [];
    const backgroundErrors: Array<{ error: unknown; operation: string; runId: string | null }> = [];
    const gateway = new ScenarioGateway(runtime, {
      emit: (event) => events.push(event),
      onBackgroundError: (error, context) => backgroundErrors.push({ error, ...context }),
    });

    await expect(gateway.handle({
      type: "request",
      requestId: "invalid-projection-subscribe",
      payload: { operation: "subscribe", runId, afterSeq: cursor },
    })).resolves.toMatchObject({ ok: true });
    expect(backgroundErrors).toMatchObject([{
      operation: "subscribe",
      runId,
    }]);
    expect(events).toEqual([expect.objectContaining({
      type: "resyncRequired",
      runId,
      expectedNextSeq: cursor + 1,
      receivedFromSeq: null,
    })]);

    await runtime.dispatch({
      runId,
      commandId: "after-invalid-projection",
      source: { kind: "scenarioFixture" },
      recordedAt: "2026-07-15T12:00:00.000Z",
      payload: { type: "planStateChanged", data: { shouldNotStream: true } },
    });
    expect(events).toHaveLength(1);
    await gateway.dispose();
  });

  it("releases a subscription when the event-batch sink throws", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-throwing-batch-sink-");
    const runtime = createTestScenarioRuntime({ root });
    const base = {
      runId: "throwing-batch-sink-run",
      source: { kind: "scenarioFixture" as const },
      recordedAt: "2026-07-15T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "throwing-batch-start",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    let attempts = 0;
    const backgroundErrors: Array<{ error: unknown; operation: string; runId: string | null }> = [];
    const gateway = new ScenarioGateway(runtime, {
      emit: () => {
        attempts += 1;
        throw new Error("broken event-batch sink");
      },
      pollIntervalMs: 5,
      onBackgroundError: (error, context) => backgroundErrors.push({ error, ...context }),
    });
    const cursor = (await runtime.snapshot(base.runId)).lastRecordSeq;
    await gateway.handle({
      type: "request",
      requestId: "throwing-batch-subscribe",
      payload: { operation: "subscribe", runId: base.runId, afterSeq: cursor },
    });

    await runtime.dispatch({
      ...base,
      commandId: "throwing-batch-first",
      payload: { type: "planStateChanged", data: { step: 1 } },
    });
    await runtime.dispatch({
      ...base,
      commandId: "throwing-batch-second",
      payload: { type: "planStateChanged", data: { step: 2 } },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(attempts).toBe(1);
    expect(backgroundErrors).toMatchObject([{
      error: { message: "broken event-batch sink" },
      operation: "subscribe",
      runId: base.runId,
    }]);
    await gateway.dispose();
  });

  it("releases polling before a throwing resync-required sink", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-throwing-resync-sink-");
    const runtime = createTestScenarioRuntime({ root });
    const base = {
      runId: "throwing-resync-sink-run",
      source: { kind: "scenarioFixture" as const },
      recordedAt: "2026-07-15T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "throwing-resync-start",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    const cursor = (await runtime.snapshot(base.runId)).lastRecordSeq;
    const poll = vi.spyOn(runtime, "committedBatchesAfter").mockResolvedValueOnce([{
      runId: base.runId,
      fromSeq: cursor + 2,
      toSeq: cursor + 2,
      baseSnapshotRevision: 1,
      resultingSnapshotRevision: 2,
      records: [{
        runId: base.runId,
        recordSeq: cursor + 2,
        recordId: "throwing-resync-gap-record",
        recordedAt: base.recordedAt,
        commandId: "throwing-resync-gap-command",
        eventType: "runtime.error",
        visibility: "localSensitive",
        payload: { message: "gap" },
      }],
    }]);
    let attempts = 0;
    const backgroundErrors: Array<{ error: unknown; operation: string; runId: string | null }> = [];
    const gateway = new ScenarioGateway(runtime, {
      emit: () => {
        attempts += 1;
        throw new Error("broken resync sink");
      },
      pollIntervalMs: 5,
      onBackgroundError: (error, context) => backgroundErrors.push({ error, ...context }),
    });

    await expect(gateway.handle({
      type: "request",
      requestId: "throwing-resync-subscribe",
      payload: { operation: "subscribe", runId: base.runId, afterSeq: cursor },
    })).resolves.toMatchObject({ ok: true });
    const pollsAfterCleanup = poll.mock.calls.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(attempts).toBe(1);
    expect(backgroundErrors).toMatchObject([{
      error: { message: "broken resync sink" },
      operation: "subscribe",
      runId: base.runId,
    }]);
    expect(poll).toHaveBeenCalledTimes(pollsAfterCleanup);
    await gateway.dispose();
  });

  it("queues live commits while an older subscription cursor is catching up", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-catch-up-race-");
    const runtime = createTestScenarioRuntime({ root });
    const base = {
      runId: "catch-up-run",
      source: { kind: "scenarioFixture" as const },
      recordedAt: "2026-07-15T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "catch-up-start",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    let releaseCatchUp!: () => void;
    const catchUpPaused = new Promise<void>((resolve) => { releaseCatchUp = resolve; });
    let markCatchUpStarted!: () => void;
    const catchUpStarted = new Promise<void>((resolve) => { markCatchUpStarted = resolve; });
    const committedBatchesAfter = runtime.committedBatchesAfter.bind(runtime);
    vi.spyOn(runtime, "committedBatchesAfter").mockImplementationOnce(async (runId, afterSeq) => {
      markCatchUpStarted();
      await catchUpPaused;
      return committedBatchesAfter(runId, afterSeq);
    });
    const events: ScenarioGatewayEvent[] = [];
    const gateway = new ScenarioGateway(runtime, { emit: (event) => events.push(event) });
    const subscription = gateway.handle({
      type: "request",
      requestId: "catch-up-subscribe",
      payload: { operation: "subscribe", runId: base.runId, afterSeq: 0 },
    });
    await catchUpStarted;
    await runtime.dispatch({
      ...base,
      commandId: "catch-up-live",
      payload: { type: "planStateChanged", data: { step: "live" } },
    });
    releaseCatchUp();
    await expect(subscription).resolves.toMatchObject({ ok: true });

    expect(events.some((event) => event.type === "resyncRequired")).toBe(false);
    const batches = events.flatMap((event) => event.type === "eventBatch" ? [event.batch] : []);
    expect(batches).toHaveLength(2);
    expect(batches[0]?.fromSeq).toBe(1);
    expect(batches[1]?.fromSeq).toBe((batches[0]?.toSeq ?? 0) + 1);
    const recordSequences = batches.flatMap((batch) => batch.records.map((record) => record.recordSeq));
    expect(new Set(recordSequences).size).toBe(recordSequences.length);
    expect(batches[1]?.records.some((record) => record.commandId === "catch-up-live")).toBe(true);
    await gateway.dispose();
  });

  it("does not emit after disposal releases an in-flight subscription poll", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-stopped-poll-");
    const runtime = createTestScenarioRuntime({ root });
    await runtime.dispatch(testStartRunCommand({
      runId: "stopped-poll-run", commandId: "stopped-start", source: { kind: "scenarioFixture" },
      recordedAt: "2026-07-15T12:00:00.000Z",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const original = runtime.committedBatchesAfter.bind(runtime);
    vi.spyOn(runtime, "committedBatchesAfter").mockImplementationOnce(async (...args) => {
      entered(); await paused; return original(...args);
    });
    const events: ScenarioGatewayEvent[] = [];
    const gateway = new ScenarioGateway(runtime, { emit: (event) => events.push(event) });
    const subscribing = gateway.handle({ type: "request", requestId: "stopped-subscribe",
      payload: { operation: "subscribe", runId: "stopped-poll-run", afterSeq: 0 } });
    await started;
    const disposing = gateway.dispose();
    release();
    await disposing;
    await subscribing;
    expect(events).toEqual([]);
  });

  it("commits tool decisions canonically before waking the provider permission waiter", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-decision-");
    let generated = 0;
    const runtime = createTestScenarioRuntime({ root, idFactory: () => `decision-${++generated}` });
    const base = {
      runId: "decision-run",
      source: { kind: "providerSdk" as const, provider: "test" },
      recordedAt: "2026-07-15T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "start",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    await runtime.dispatch({
      ...base,
      commandId: "tool",
      payload: {
        type: "toolRequested",
        toolCallId: "tool-1",
        turnId: "turn-1",
        name: "Read",
        input: { file_path: "README.md" },
        inputDigest: digestScenarioValue({ file_path: "README.md" }),
        requiresUserDecision: true,
      },
    });
    const settled: unknown[] = [];
    const gateway = new ScenarioGateway(runtime, {
      providerHost: {
        async start() { return { runId: "decision-run" }; },
        async resume(runId) { return { runId }; },
        async send() {},
        async cancel() {},
        async close() {},
        async settleToolDecision(...args) {
          settled.push(args);
          expect((await runtime.snapshot("decision-run")).toolCalls[0]?.authorization.user)
            .toBe("approved");
          return "settled" as const;
        },
      },
    });

    expect(await gateway.handle({
      type: "request",
      requestId: "approve",
      payload: {
        operation: "submitToolDecision",
        runId: "decision-run",
        toolCallId: "tool-1",
        decision: "approve",
        reason: null,
      },
    })).toMatchObject({ ok: true, payload: { result: { status: "allowed" } } });
    expect(settled).toEqual([["decision-run", "tool-1", "approve", null]]);

    await runtime.dispatch({
      ...base,
      commandId: "tool-2",
      payload: {
        type: "toolRequested",
        toolCallId: "tool-2",
        turnId: "turn-1",
        name: "Read",
        input: { file_path: "CLAUDE.md" },
        inputDigest: digestScenarioValue({ file_path: "CLAUDE.md" }),
        requiresUserDecision: true,
      },
    });
    const detachedGateway = new ScenarioGateway(runtime, {
      providerHost: {
        async start() { return { runId: "decision-run" }; },
        async resume(runId) { return { runId }; },
        async send() {},
        async cancel() {},
        async close() {},
        async settleToolDecision() { return "providerDetached"; },
      },
    });
    expect(await detachedGateway.handle({
      type: "request",
      requestId: "approve-detached",
      payload: {
        operation: "submitToolDecision",
        runId: "decision-run",
        toolCallId: "tool-2",
        decision: "approve",
        reason: null,
      },
    })).toMatchObject({
      ok: true,
      payload: {
        result: {
          status: "allowed",
          data: { providerCoordination: "providerDetached" },
        },
      },
    });
    expect((await runtime.snapshot("decision-run")).toolCalls[1]?.authorization.user).toBe("approved");

    await runtime.dispatch({
      ...base,
      commandId: "tool-3",
      payload: {
        type: "toolRequested",
        toolCallId: "tool-3",
        turnId: "turn-1",
        name: "Read",
        input: { file_path: "package.json" },
        inputDigest: digestScenarioValue({ file_path: "package.json" }),
        requiresUserDecision: true,
      },
    });
    const cancellationCalls: unknown[] = [];
    const failedCoordination = new ScenarioGateway(runtime, {
      providerHost: {
        async start() { return { runId: "decision-run" }; },
        async resume(runId) { return { runId }; },
        async send() {},
        async cancel(...args) { cancellationCalls.push(args); },
        async close() {},
        async settleToolDecision() { throw new Error("provider waiter disappeared"); },
      },
    });
    expect(await failedCoordination.handle({
      type: "request",
      requestId: "approve-coordination-failed",
      payload: {
        operation: "submitToolDecision",
        runId: "decision-run",
        toolCallId: "tool-3",
        decision: "approve",
        reason: null,
      },
    })).toMatchObject({
      ok: true,
      payload: { result: { data: { providerCoordination: "providerCancelled" } } },
    });
    expect(cancellationCalls).toEqual([["decision-run", null]]);
    expect((await runtime.snapshot("decision-run")).toolCalls[2]?.authorization.user).toBe("approved");
    expect((await runtime.recordsAfter("decision-run", 0)).some((record) =>
      record.eventType === "store.diagnostic" && JSON.stringify(record.payload).includes("provider waiter disappeared")
    )).toBe(true);
  });

  it("cancels and detaches an active provider when tool-decision settlement throws", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-decision-cleanup-");
    const runtime = createTestScenarioRuntime({ root });
    let authorizationAttempt: Promise<unknown> | undefined;
    const manager = new ScenarioProviderManager({
      runtime,
      resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
      createRunner: (resolvedProvider, authorizeTool): ProviderRunner => ({
        resolvedProvider,
        async *runTurn(input) {
          authorizationAttempt = authorizeTool({
            toolCallId: "tool-coordination-failure",
            turnId: input.turnId,
            toolName: "Read",
            toolInput: { file_path: "README.md" },
            signal: input.signal,
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
    await manager.host.send(runId, "turn-coordination-failure", "inspect README");
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(runId)).toolCalls[0]?.status).toBe("waiting");
    });

    const gateway = new ScenarioGateway(runtime, {
      providerHost: {
        ...manager.host,
        async settleToolDecision() {
          throw new Error("provider waiter disappeared");
        },
      },
    });
    await expect(gateway.handle({
      type: "request",
      requestId: "coordination-failure",
      payload: {
        operation: "submitToolDecision",
        runId,
        toolCallId: "tool-coordination-failure",
        decision: "approve",
        reason: null,
      },
    })).resolves.toMatchObject({
      ok: true,
      payload: { result: { data: { providerCoordination: "providerCancelled" } } },
    });

    expect(authorizationAttempt).toBeDefined();
    await expect(authorizationAttempt).rejects.toThrow("Tool authorization cancelled");
    expect(await runtime.snapshot(runId)).toMatchObject({
      status: "cancelled",
      toolCalls: [{
        id: "tool-coordination-failure",
        status: "cancelled",
        authorization: { final: "cancelled" },
      }],
    });
    await expect(manager.host.send(runId, "late-turn", "must not reach provider"))
      .rejects.toThrow(`Unknown provider run: ${runId}`);
    await manager.dispose();
  });

  it("sanitizes unexpected gateway errors while retaining a local diagnostic", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-gateway-public-error-");
    const runtime = createTestScenarioRuntime({ root });
    await runtime.dispatch(testStartRunCommand({
      runId: "public-error-run",
      commandId: "public-error-start",
      source: { kind: "scenarioFixture" },
      recordedAt: "2026-07-15T12:00:00.000Z",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    const sentinel = "/private/provider/secret-path";
    vi.spyOn(runtime, "snapshot").mockRejectedValueOnce(new Error(`filesystem failed at ${sentinel}`));
    const gateway = new ScenarioGateway(runtime, {
      authority: { scopes: ["run.read"], visibilityScope: ["public"] },
    });
    const response = await gateway.handle({
      type: "request",
      requestId: "sanitized-error",
      payload: { operation: "getSnapshot", runId: "public-error-run" },
    });
    expect(response).toMatchObject({
      ok: false,
      payload: { code: "gateway_error", message: "Gateway operation failed" },
    });
    expect(JSON.stringify(response)).not.toContain(sentinel);
    expect((await runtime.recordsAfter("public-error-run", 0)).some((record) =>
      record.eventType === "store.diagnostic" && JSON.stringify(record.payload).includes(sentinel)
    )).toBe(true);

    const backgroundErrors: Array<{ error: unknown; operation: string; runId: string | null }> = [];
    vi.spyOn(runtime, "recordDiagnostic").mockRejectedValueOnce(new Error("diagnostic persistence failed"));
    vi.spyOn(runtime, "snapshot").mockRejectedValueOnce(new Error("second gateway failure"));
    const reportingGateway = new ScenarioGateway(runtime, {
      authority: { scopes: ["run.read"], visibilityScope: ["public"] },
      onBackgroundError: (error, context) => backgroundErrors.push({ error, ...context }),
    });
    expect(await reportingGateway.handle({
      type: "request",
      requestId: "diagnostic-persistence-error",
      payload: { operation: "getSnapshot", runId: "public-error-run" },
    })).toMatchObject({
      ok: false,
      payload: { code: "gateway_error", message: "Gateway operation failed" },
    });
    expect(backgroundErrors).toMatchObject([{
      error: { message: "diagnostic persistence failed" },
      operation: "getSnapshot",
      runId: "public-error-run",
    }]);
  });
});
