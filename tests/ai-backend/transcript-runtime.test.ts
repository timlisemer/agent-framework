import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalNativeTranscriptObservation } from "../../src/entrypoints/native-transcript.js";
import { digestScenarioValue } from "../../src/scenario/protocol/digest.js";
import { scenarioProtocolSchemaDigest } from "../../src/scenario/protocol/schema.js";
import { nativeTranscriptDataSchema } from "../../src/scenario/protocol/commands.js";
import {
  createDeterministicPolicyExecutor,
  createTestScenarioRuntime,
} from "../helpers/scenario-runtime.js";
import { testStartRunCommand } from "../helpers/scenario-fixtures.js";
import { canonicalTranscriptFromSnapshot } from "../../src/effects/rule-pipeline-executor.js";
import { dispatchUserPromptSubmit } from "../../src/entrypoints/host-hook.js";
import { canonicalHookRunId } from "../../src/entrypoints/host-run-id.js";
import type { AdapterEncoder } from "../../src/adapter/types.js";
import { activeSpec } from "../../src/adapter/spec.js";
import { agentFrameworkHostCommand } from "../../src/effects/host-command.js";
import { withTemporaryTestRoot } from "../helpers/temporary-root.js";
import { withEnvironmentForTest } from "../helpers/environment.js";

const testEncoder: AdapterEncoder = {
  name: "test",
  encodePreToolUseAllow: () => ({ stdout: "", exitCode: 0 }),
  encodePreToolUseDeny: () => ({ stdout: "", exitCode: 2 }),
  encodeStopBlock: () => ({ stdout: "", exitCode: 2 }),
  encodeStopPass: () => ({ stdout: "", exitCode: 0 }),
  encodeOk: () => ({ stdout: "", exitCode: 0 }),
  encodeContext: () => ({ stdout: "", exitCode: 0 }),
  encodeError: () => ({ stdout: "", exitCode: 1 }),
};

describe("native transcript importer", () => {
  it("tolerates missing transcripts but propagates other filesystem failures", async () => {
    await withTemporaryTestRoot("native-transcript-errors-", async (temporaryDir) => {
      const missingPath = path.join(temporaryDir, "missing.jsonl");
      const realLstat = fs.promises.lstat.bind(fs.promises);
      let missingReads = 0;
      const lstat = vi.spyOn(fs.promises, "lstat").mockImplementation(async (...args) => {
        if (args[0] === missingPath) missingReads += 1;
        return realLstat(...args);
      });
      try {
        await expect(canonicalNativeTranscriptObservation({
          adapterName: "claude",
          transcriptPath: missingPath,
        })).resolves.toMatchObject({
          availability: "missing",
          data: { messages: [], tools: [] },
          metadata: {
            recentUserMessages: [],
            cachedSnippetSideTaskDischarged: false,
            slashCommandAllowedTools: null,
            parallelBatch: null,
            stop: {
              assistantTextCandidates: [],
              latestAssistantText: null,
              latestUserText: null,
              priorErrorContext: [],
            },
          },
        });
        expect(missingReads).toBe(2);
      } finally {
        lstat.mockRestore();
      }
      const emptyPath = path.join(temporaryDir, "empty.jsonl");
      fs.writeFileSync(emptyPath, "", "utf8");
      await expect(canonicalNativeTranscriptObservation({
        adapterName: "claude",
        transcriptPath: emptyPath,
      })).resolves.toMatchObject({
        availability: "present",
        data: { messages: [], tools: [] },
      });
      await expect(canonicalNativeTranscriptObservation({
        adapterName: "claude",
        transcriptPath: temporaryDir,
      })).rejects.toThrow("Native transcript is not a regular file");
    });
  });

  it("retries an observation when the native transcript changes during parsing", async () => {
    await withTemporaryTestRoot("native-transcript-stable-read-", async (temporaryDir) => {
      const transcriptPath = path.join(temporaryDir, "session.jsonl");
      const older = JSON.stringify({
        type: "user",
        uuid: "older-turn",
        message: { id: "older-message", role: "user", content: "older content" },
      });
      const newer = JSON.stringify({
        type: "user",
        uuid: "newer-turn",
        message: { id: "newer-message", role: "user", content: "newer content" },
      });
      fs.writeFileSync(transcriptPath, older, "utf8");
      const lstat = fs.promises.lstat.bind(fs.promises);
      let transcriptStats = 0;
      const lstatSpy = vi.spyOn(fs.promises, "lstat").mockImplementation(async (...args) => {
        const stats = await lstat(...args);
        if (args[0] === transcriptPath && transcriptStats++ === 3) {
          fs.writeFileSync(transcriptPath, newer, "utf8");
        }
        return stats;
      });
      try {
        await expect(canonicalNativeTranscriptObservation({
          adapterName: "claude",
          transcriptPath,
        })).resolves.toMatchObject({
          data: { messages: [{ id: "newer-message", content: "newer content" }] },
        });
        expect(transcriptStats).toBeGreaterThan(6);
      } finally {
        lstatSpy.mockRestore();
      }
    });
  });

  it("imports native tool calls losslessly without tool-log sidecars", async () => {
    await withTemporaryTestRoot("native-transcript-import-", async (temporaryDir) => {
      const transcriptPath = path.join(temporaryDir, "session.jsonl");
      fs.writeFileSync(transcriptPath, [
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          message: {
            id: "message-1",
            role: "assistant",
            content: [
              { type: "text", text: "Inspecting repository" },
              {
                type: "tool_use",
                id: "tool-1",
                name: "Bash",
                input: {
                  command: "rg --files",
                  options: { hidden: true, globs: ["*.ts", "*.tsx"] },
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [{ type: "text", text: "src/index.ts" }],
            }],
          },
        }),
      ].join("\n"));

      const observation = await canonicalNativeTranscriptObservation({
        adapterName: "claude",
        transcriptPath,
      });

      expect(digestScenarioValue(observation.data)).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(observation.data).toMatchObject({
        messages: [{
          content: "Inspecting repository",
          contentDigest: digestScenarioValue("Inspecting repository"),
        }],
        tools: [{
          id: "tool-1",
          name: "Bash",
          input: {
            command: "rg --files",
            options: { hidden: true, globs: ["*.ts", "*.tsx"] },
          },
          status: "completed",
          output: ["src/index.ts"],
          error: null,
        }],
      });
      const data = observation.data as {
        tools: Array<{ input: { command: string; options: { hidden: boolean; globs: string[] } }; inputDigest: string }>;
      };
      expect(data.tools[0]?.inputDigest).toBe(digestScenarioValue(data.tools[0]!.input));
      expect(digestScenarioValue({ command: "rg --files", options: { hidden: true, globs: ["*.ts", "*.tsx"] } }))
        .toBe(digestScenarioValue({ options: { globs: ["*.ts", "*.tsx"], hidden: true }, command: "rg --files" }));
    });
  });

  it("aggregates split Claude assistant entries before dispatching the native observation", async () => {
    await withTemporaryTestRoot("native-transcript-split-assistant-", async (temporaryDir) => {
      const transcriptPath = path.join(temporaryDir, "session.jsonl");
      fs.writeFileSync(transcriptPath, [
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-entry-1",
          message: {
            id: "split-assistant-message",
            role: "assistant",
            content: [
              { type: "text", text: "Inspecting" },
              { type: "tool_use", id: "split-tool", name: "Bash", input: { command: "rg --files" } },
            ],
          },
          usage: { input_tokens: 4, output_tokens: 1 },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-entry-2",
          message: {
            id: "split-assistant-message",
            role: "assistant",
            content: [{ type: "text", text: "repository now" }],
          },
          usage: { input_tokens: 4, output_tokens: 3 },
        }),
        JSON.stringify({
          type: "user",
          uuid: "tool-result-entry",
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "split-tool",
              content: [{ type: "text", text: "src/index.ts" }],
            }],
          },
        }),
      ].join("\n"));

      const observation = await canonicalNativeTranscriptObservation({
        adapterName: "claude",
        transcriptPath,
      });
      expect(observation.data).toMatchObject({
        messages: [{
          id: "split-assistant-message",
          turnId: "assistant-entry-1",
          role: "assistant",
          content: "Inspecting repository now",
          usage: { input_tokens: 4, output_tokens: 3 },
        }],
        tools: [{
          id: "split-tool",
          turnId: "assistant-entry-1",
          status: "completed",
          output: ["src/index.ts"],
        }],
      });

      const runtime = createTestScenarioRuntime({ root: path.join(temporaryDir, "runtime") });
      const source = { kind: "hostHook" as const, adapter: "claude", nativeSessionId: "split-session" };
      await runtime.dispatch(testStartRunCommand({
        commandId: "split-start",
        runId: "split-run",
        source,
        recordedAt: "2026-07-16T12:00:00.000Z",
        payload: {
          workingDir: temporaryDir,
          projectDir: temporaryDir,
          schemaDigest: scenarioProtocolSchemaDigest(),
        },
      }));
      await runtime.dispatch({
        commandId: "split-native-observation",
        runId: "split-run",
        source,
        recordedAt: "2026-07-16T12:00:01.000Z",
        payload: {
          type: "nativeTranscriptObserved",
          data: nativeTranscriptDataSchema.parse({
            ...(observation.data as Record<string, unknown>),
            digest: digestScenarioValue(observation.data),
          }),
        },
      });

      const snapshot = await runtime.snapshot("split-run");
      expect(snapshot.conversation).toMatchObject([{
        id: "split-assistant-message",
        turnId: "assistant-entry-1",
        role: "assistant",
        content: "Inspecting repository now",
        status: "completed",
      }]);
      expect(snapshot.toolCalls).toMatchObject([{
        id: "split-tool",
        turnId: "assistant-entry-1",
        status: "completed",
        output: ["src/index.ts"],
      }]);
      expect((await runtime.recordsAfter("split-run", 0)).filter((record) =>
        record.eventType === "message.observed" && record.payload.messageId === "split-assistant-message"
      )).toHaveLength(1);
    });
  });

  it("reconciles a host-submitted prompt with its later native transcript representation", async () => {
    await withTemporaryTestRoot("native-transcript-reconcile-", async (temporaryDir) => {
      const transcriptPath = path.join(temporaryDir, "session.jsonl");
      const prompt = "Please inspect the repository";
      fs.writeFileSync(transcriptPath, JSON.stringify({
        type: "user",
        uuid: "native-user-turn",
        message: { id: "native-user-message", role: "user", content: prompt },
      }));
      const runtime = createTestScenarioRuntime({ root: path.join(temporaryDir, "runtime") });
      const source = { kind: "hostHook" as const, adapter: "claude", nativeSessionId: "session-1" };
      await runtime.dispatch(testStartRunCommand({
        commandId: "reconcile-start",
        runId: "reconcile-run",
        source,
        recordedAt: "2026-07-16T12:00:00.000Z",
        payload: {
          workingDir: temporaryDir,
          projectDir: temporaryDir,
          schemaDigest: scenarioProtocolSchemaDigest(),
        },
      }));
      await runtime.dispatch({
        commandId: "host-prompt",
        runId: "reconcile-run",
        source,
        recordedAt: "2026-07-16T12:00:01.000Z",
        payload: agentFrameworkHostCommand({
          type: "hostUserPromptSubmitted",
          workflow: {},
          context: {},
          messageId: "host-random-message",
          prompt,
          contentDigest: digestScenarioValue(prompt),
        }),
      });
      const observation = await canonicalNativeTranscriptObservation({ adapterName: "claude", transcriptPath });
      await runtime.dispatch({
        commandId: "native-observation",
        runId: "reconcile-run",
        source,
        recordedAt: "2026-07-16T12:00:02.000Z",
        payload: {
          type: "nativeTranscriptObserved",
          data: nativeTranscriptDataSchema.parse({
            ...(observation.data as Record<string, unknown>),
            digest: digestScenarioValue(observation.data),
          }),
        },
      });

      const snapshot = await runtime.snapshot("reconcile-run");
      expect(snapshot.conversation.filter((message) =>
        message.role === "user" && message.content === prompt
      )).toHaveLength(1);
      const generatedRows = canonicalTranscriptFromSnapshot(snapshot)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { message?: { role?: string; content?: string } });
      expect(generatedRows.filter((row) =>
        row.message?.role === "user" && row.message.content === prompt
      )).toHaveLength(1);
    });
  });

  it("retires rewound and cleared native history from active state without erasing the journal", async () => {
    await withTemporaryTestRoot("native-transcript-rewind-", async (temporaryDir) => {
      const runtime = createTestScenarioRuntime({ root: path.join(temporaryDir, "runtime") });
      const source = { kind: "hostHook" as const, adapter: "claude", nativeSessionId: "rewind-session" };
      await runtime.dispatch(testStartRunCommand({
        commandId: "rewind-start",
        runId: "rewind-run",
        source,
        recordedAt: "2026-07-16T12:00:00.000Z",
        payload: {
          workingDir: temporaryDir,
          projectDir: temporaryDir,
          schemaDigest: scenarioProtocolSchemaDigest(),
        },
      }));
      const retainedContent = "Retained before clear";
      const retiredContent = "Authorization removed by rewind";
      const toolInput = { command: "printf stale" };
      const messages = [
        {
          id: "rewind-message-retained",
          turnId: "rewind-turn-retained",
          role: "user" as const,
          content: retainedContent,
          contentDigest: digestScenarioValue(retainedContent),
          status: "completed" as const,
        },
        {
          id: "rewind-message-retired",
          turnId: "rewind-turn-retired",
          role: "user" as const,
          content: retiredContent,
          contentDigest: digestScenarioValue(retiredContent),
          status: "completed" as const,
        },
      ];
      const tools = [{
        id: "rewind-tool-retired",
        turnId: "rewind-turn-retired",
        name: "Bash",
        input: toolInput,
        inputDigest: digestScenarioValue(toolInput),
        status: "completed" as const,
        output: ["stale output"],
        error: null,
      }];
      await runtime.dispatch({
        commandId: "rewind-observe-full",
        runId: "rewind-run",
        source,
        recordedAt: "2026-07-16T12:00:01.000Z",
        payload: { type: "nativeTranscriptObserved", data: { messages, tools } },
      });
      await runtime.dispatch({
        commandId: "rewind-observe-shortened",
        runId: "rewind-run",
        source,
        recordedAt: "2026-07-16T12:00:02.000Z",
        payload: { type: "nativeTranscriptObserved", data: { messages: [messages[0]!], tools: [] } },
      });

      const rewound = await runtime.snapshot("rewind-run");
      expect(rewound.conversation.map((message) => message.id)).toEqual(["rewind-message-retained"]);
      expect(rewound.toolCalls).toEqual([]);
      expect(canonicalTranscriptFromSnapshot(rewound)).toContain(retainedContent);
      expect(canonicalTranscriptFromSnapshot(rewound)).not.toContain(retiredContent);
      expect(canonicalTranscriptFromSnapshot(rewound)).not.toContain("rewind-tool-retired");

      await runtime.dispatch({
        commandId: "rewind-observe-cleared",
        runId: "rewind-run",
        source,
        recordedAt: "2026-07-16T12:00:03.000Z",
        payload: { type: "nativeTranscriptObserved", data: { messages: [], tools: [] } },
      });
      const cleared = await runtime.snapshot("rewind-run");
      expect(cleared.conversation).toEqual([]);
      expect(cleared.toolCalls).toEqual([]);

      const journal = await runtime.recordsAfter("rewind-run", 0);
      expect(journal.some((record) =>
        record.eventType === "message.observed" && record.payload.messageId === "rewind-message-retired"
      )).toBe(true);
      expect(journal.some((record) =>
        record.eventType === "tool.requested" && record.payload.toolCallId === "rewind-tool-retired"
      )).toBe(true);
      expect(journal.filter((record) => record.eventType === "message.retired")).toHaveLength(2);
      expect(journal.filter((record) => record.eventType === "tool.retired")).toHaveLength(1);
    });
  });

  it("reconciles production-order native prompts by occurrence and retires compacted history", async () => {
    await withTemporaryTestRoot("native-transcript-production-order-", async (temporaryDir) => {
      const transcriptPath = path.join(temporaryDir, "session.jsonl");
      const prompt = "Please inspect the repository";
      const restoreEnvironment = withEnvironmentForTest({
        AGENT_FRAMEWORK_SESSION_POLICY: "none",
        AGENT_FRAMEWORK_VOLATILE_DIR: path.join(temporaryDir, "session"),
      });
      const runtime = createTestScenarioRuntime({ root: path.join(temporaryDir, "runtime") });
      const input = {
        session_id: "production-order-session",
        transcript_path: transcriptPath,
        cwd: temporaryDir,
        prompt,
      };
      try {
        fs.writeFileSync(transcriptPath, JSON.stringify({
          type: "user",
          uuid: "native-user-turn-1",
          message: { id: "native-user-message-1", role: "user", content: prompt },
        }));
        await dispatchUserPromptSubmit(input, testEncoder, { runtime });
        const runId = canonicalHookRunId(activeSpec().name, transcriptPath);
        expect((await runtime.snapshot(runId)).conversation.filter((message) =>
          message.role === "user" && message.content === prompt
        )).toHaveLength(1);

        fs.appendFileSync(transcriptPath, `\n${JSON.stringify({
          type: "user",
          uuid: "native-user-turn-2",
          message: { id: "native-user-message-2", role: "user", content: prompt },
        })}`);
        await dispatchUserPromptSubmit(input, testEncoder, { runtime });
        expect((await runtime.snapshot(runId)).conversation.filter((message) =>
          message.role === "user" && message.content === prompt
        )).toHaveLength(2);

        fs.writeFileSync(transcriptPath, JSON.stringify({
          type: "user",
          uuid: "native-user-turn-2",
          message: { id: "native-user-message-2", role: "user", content: prompt },
        }));
        await dispatchUserPromptSubmit(input, testEncoder, { runtime });
        expect((await runtime.snapshot(runId)).conversation.filter((message) =>
          message.role === "user" && message.content === prompt
        )).toMatchObject([{ id: "native-user-message-2" }]);

        const compactedPrompt = "Continue from the compacted context";
        fs.writeFileSync(transcriptPath, JSON.stringify({
          type: "user",
          uuid: "native-user-turn-compacted",
          message: { id: "native-user-message-compacted", role: "user", content: compactedPrompt },
        }));
        input.prompt = compactedPrompt;
        await dispatchUserPromptSubmit(input, testEncoder, { runtime });
        const compacted = await runtime.snapshot(runId);
        expect(compacted.conversation.filter((message) => message.role === "user")).toMatchObject([{
          id: "native-user-message-compacted",
          content: compactedPrompt,
        }]);
        expect(canonicalTranscriptFromSnapshot(compacted)).not.toContain(prompt);
        expect((await runtime.recordsAfter(runId, 0)).filter((record) =>
          record.eventType === "message.retired"
        )).toHaveLength(2);
      } finally {
        restoreEnvironment();
      }
    });
  });

  it.each([
    { history: "message-and-tool", includeNativeMessage: true },
    { history: "tool-only", includeNativeMessage: false },
  ])("fails closed without retiring $history native history when the transcript disappears", async ({
    includeNativeMessage,
  }) => {
    await withTemporaryTestRoot("native-transcript-missing-after-import-", async (temporaryDir) => {
      const transcriptPath = path.join(temporaryDir, "session.jsonl");
      const prompt = "Preserve this authorization context";
      const toolInput = { command: "rg --files" };
      fs.writeFileSync(transcriptPath, [
        ...(includeNativeMessage ? [JSON.stringify({
          type: "user",
          uuid: "preserved-user-turn",
          message: { id: "preserved-user-message", role: "user", content: prompt },
        })] : []),
        JSON.stringify({
          type: "assistant",
          uuid: "preserved-assistant-turn",
          message: {
            id: "preserved-assistant-message",
            role: "assistant",
            content: [{ type: "tool_use", id: "preserved-tool", name: "Bash", input: toolInput }],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "preserved-tool-result",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "preserved-tool", content: "src/index.ts" }],
          },
        }),
      ].join("\n"), "utf8");
      const restoreEnvironment = withEnvironmentForTest({
        AGENT_FRAMEWORK_SESSION_POLICY: "none",
        AGENT_FRAMEWORK_VOLATILE_DIR: path.join(temporaryDir, "session"),
      });
      const delegate = createDeterministicPolicyExecutor();
      const execute = vi.fn(delegate.execute.bind(delegate));
      const runtime = createTestScenarioRuntime({
        root: path.join(temporaryDir, "runtime"),
        effectExecutor: { execute },
      });
      const input = {
        session_id: "missing-after-import-session",
        transcript_path: transcriptPath,
        delivery_id: `missing-after-import-${includeNativeMessage ? "message" : "tool"}`,
        cwd: temporaryDir,
        prompt,
      };
      try {
        await dispatchUserPromptSubmit(input, testEncoder, { runtime });
        const runId = canonicalHookRunId(activeSpec().name, transcriptPath);
        const before = await runtime.canonicalView(runId);
        const executionsBeforeMissingRead = execute.mock.calls.length;
        const nativeState = before.snapshot.stateSlices["transcript.native"]?.value as {
          messageIds: string[];
          toolCallIds: string[];
        };
        expect(nativeState.messageIds).toEqual(includeNativeMessage ? ["preserved-user-message"] : []);
        expect(nativeState.toolCallIds).toEqual(["preserved-tool"]);
        expect(before.snapshot.toolCalls.map((tool) => tool.id)).toContain("preserved-tool");

        fs.rmSync(transcriptPath);
        await expect(dispatchUserPromptSubmit(input, testEncoder, { runtime }))
          .rejects.toThrow("Native transcript is unavailable while canonical native history is active");

        const after = await runtime.canonicalView(runId);
        expect(after.records).toEqual(before.records);
        expect(after.snapshot.conversation).toEqual(before.snapshot.conversation);
        expect(after.snapshot.toolCalls).toEqual(before.snapshot.toolCalls);
        expect(after.records.filter((record) =>
          record.eventType === "message.retired" || record.eventType === "tool.retired"
        )).toEqual([]);
        expect(execute).toHaveBeenCalledTimes(executionsBeforeMissingRead);
      } finally {
        restoreEnvironment();
      }
    });
  });

  it.each([
    { terminal: "completed" as const, startRunning: false, error: null },
    { terminal: "failed" as const, startRunning: true, error: "native command failed" },
  ])("advances an existing tool to native $terminal state without duplicates", async ({
    terminal,
    startRunning,
    error,
  }) => {
    await withTemporaryTestRoot(`native-tool-${terminal}-`, async (temporaryDir) => {
      const runtime = createTestScenarioRuntime({ root: path.join(temporaryDir, "runtime") });
      const source = { kind: "hostHook" as const, adapter: "codex", nativeSessionId: "session-tool" };
      await runtime.dispatch(testStartRunCommand({
        commandId: `start-${terminal}`,
        runId: "tool-reconcile-run",
        source,
        recordedAt: "2026-07-16T12:00:00.000Z",
        payload: {
          workingDir: temporaryDir,
          projectDir: temporaryDir,
          schemaDigest: scenarioProtocolSchemaDigest(),
        },
      }));
      const input = { command: "rg -n TODO src" };
      await runtime.dispatch({
        commandId: `request-${terminal}`,
        runId: "tool-reconcile-run",
        source,
        recordedAt: "2026-07-16T12:00:01.000Z",
        payload: {
          type: "toolRequested",
          toolCallId: "existing-tool",
          turnId: "tool-turn",
          name: "Bash",
          input,
          inputDigest: digestScenarioValue(input),
          requiresUserDecision: false,
        },
      });
      if (startRunning) {
        await runtime.dispatch({
          commandId: `running-${terminal}`,
          runId: "tool-reconcile-run",
          source,
          recordedAt: "2026-07-16T12:00:02.000Z",
          payload: { type: "toolExecutionStarted", toolCallId: "existing-tool" },
        });
      }
      const observedTool = {
        id: "existing-tool",
        turnId: "tool-turn",
        name: "Bash",
        input,
        inputDigest: digestScenarioValue(input),
        status: terminal,
        output: ["one native output"],
        error,
      };
      const observationData = {
        messages: [],
        tools: [observedTool],
      };
      const observation = {
        ...observationData,
        digest: digestScenarioValue(observationData),
      };
      for (const suffix of ["first", "repeat"]) {
        await runtime.dispatch({
          commandId: `observe-${terminal}-${suffix}`,
          runId: "tool-reconcile-run",
          source,
          recordedAt: "2026-07-16T12:00:03.000Z",
          payload: { type: "nativeTranscriptObserved", data: observation },
        });
      }

      const snapshot = await runtime.snapshot("tool-reconcile-run");
      expect(snapshot.toolCalls).toHaveLength(1);
      expect(snapshot.toolCalls[0]).toMatchObject({
        id: "existing-tool",
        status: terminal,
        output: ["one native output"],
        error,
      });
      expect((await runtime.recordsAfter("tool-reconcile-run", 0)).filter((record) =>
        record.eventType === `tool.${terminal}` && record.payload.toolCallId === "existing-tool"
      )).toHaveLength(1);
      const beforeInvalidObservation = {
        snapshot: await runtime.snapshot("tool-reconcile-run"),
        records: await runtime.recordsAfter("tool-reconcile-run", 0),
      };
      const invalidTools = [
        { ...observedTool, turnId: "changed-turn" },
        { ...observedTool, status: "cancelled" as const },
        { ...observedTool, output: ["changed output"] },
        { ...observedTool, error: error === null ? "changed error" : null },
      ];
      for (const [index, invalidTool] of invalidTools.entries()) {
        await expect(runtime.dispatch({
          commandId: `observe-${terminal}-invalid-${index}`,
          runId: "tool-reconcile-run",
          source,
          recordedAt: "2026-07-16T12:00:04.000Z",
          payload: {
            type: "nativeTranscriptObserved",
            data: { messages: [], tools: [invalidTool] },
          },
        })).rejects.toThrow(/Native transcript (tool identity|tool output|terminal tool) changed/);
        expect(await runtime.snapshot("tool-reconcile-run")).toEqual(beforeInvalidObservation.snapshot);
        expect(await runtime.recordsAfter("tool-reconcile-run", 0)).toEqual(beforeInvalidObservation.records);
      }
    });
  });
});
