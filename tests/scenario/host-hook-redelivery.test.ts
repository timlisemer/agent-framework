import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { codexEncoder } from "../../adapters/codex/encoder.js";
import {
  dispatchPostToolUse,
  dispatchPreToolUse,
  dispatchStop,
  dispatchUserPromptSubmit,
} from "../../src/entrypoints/host-hook.js";
import { createTestScenarioRuntime } from "../helpers/scenario-runtime.js";
import { withEnvironmentForTest } from "../helpers/environment.js";
import { withTemporaryTestRoot } from "../helpers/temporary-root.js";

describe("host-hook committed redelivery", () => {
  it("returns stored outcomes without repeating semantic work and rejects immutable conflicts", async () => {
    await withTemporaryTestRoot("host-hook-redelivery-", async (temporaryDir) => {
      const transcriptPath = path.join(temporaryDir, "codex.jsonl");
      const runtimeRoot = path.join(temporaryDir, "runtime");
      await fs.writeFile(transcriptPath, "", "utf8");
      const restoreEnvironment = withEnvironmentForTest({
        AGENT_FRAMEWORK_ADAPTER: "codex",
        AGENT_FRAMEWORK_PROJECT_DIR: temporaryDir,
        AGENT_FRAMEWORK_SESSION_POLICY: "none",
        AGENT_FRAMEWORK_VOLATILE_DIR: path.join(temporaryDir, "session"),
      });
      const base = {
        session_id: "redelivery-session",
        transcript_path: transcriptPath,
        cwd: temporaryDir,
      };
      const preTool = {
        ...base,
        tool_use_id: "redelivery-tool",
        tool_name: "Bash",
        tool_input: { command: "rg --files" },
      };
      const postTool = {
        ...preTool,
        tool_response: { stdout: "src/index.ts" },
      };
      const userPrompt = {
        ...base,
        delivery_id: "redelivery-prompt-1",
        prompt: "Please summarize the repository",
      };
      const stop = { ...base, last_assistant_message: "Repository summary complete." };
      try {
        const firstRuntime = createTestScenarioRuntime({ root: runtimeRoot });
        const firstOutputs = [
          await dispatchPreToolUse(preTool, codexEncoder, { runtime: firstRuntime }),
          await dispatchPostToolUse(postTool, codexEncoder, { runtime: firstRuntime }),
          await dispatchUserPromptSubmit(userPrompt, codexEncoder, { runtime: firstRuntime }),
          await dispatchStop(stop, codexEncoder, { runtime: firstRuntime }),
        ];
        const runId = (await firstRuntime.listRuns())[0]!.runId;
        const committed = await firstRuntime.canonicalView(runId);

        const replayRuntime = createTestScenarioRuntime({ root: runtimeRoot });
        const replayOutputs = [
          await dispatchPreToolUse(preTool, codexEncoder, { runtime: replayRuntime }),
          await dispatchPostToolUse(postTool, codexEncoder, { runtime: replayRuntime }),
          await dispatchUserPromptSubmit(userPrompt, codexEncoder, { runtime: replayRuntime }),
          await dispatchStop(stop, codexEncoder, { runtime: replayRuntime }),
        ];

        expect(replayOutputs).toEqual(firstOutputs);
        expect(await replayRuntime.canonicalView(runId)).toEqual(committed);

        await expect(dispatchPreToolUse({
          ...preTool,
          tool_input: { command: "git status" },
        }, codexEncoder, { runtime: replayRuntime })).rejects.toThrow("Command ID collision");
        await expect(dispatchPostToolUse({
          ...postTool,
          tool_response: { stdout: "changed output" },
        }, codexEncoder, { runtime: replayRuntime })).rejects.toThrow("Command ID collision");
        await expect(dispatchStop({
          ...stop,
          last_assistant_message: "Changed response under the same Stop occurrence.",
        }, codexEncoder, { runtime: replayRuntime })).rejects.toThrow("Command ID collision");
        expect(await replayRuntime.canonicalView(runId)).toEqual(committed);
      } finally {
        restoreEnvironment();
      }
    });
  });

  it.each(["missing", "empty", "lagging"] as const)(
    "distinguishes repeated identical prompts with a host delivery ID when the transcript is $state",
    async (state) => {
      await withTemporaryTestRoot(`host-hook-prompt-occurrence-${state}-`, async (temporaryDir) => {
        const transcriptPath = path.join(temporaryDir, "codex.jsonl");
        const prompt = "Repeat this exact prompt";
        if (state === "empty") await fs.writeFile(transcriptPath, "", "utf8");
        if (state === "lagging") {
          await fs.writeFile(transcriptPath, JSON.stringify({
            type: "user",
            message: { id: "lagging-native-prompt", role: "user", content: prompt },
          }), "utf8");
        }
        const runtimeRoot = path.join(temporaryDir, "runtime");
        const restoreEnvironment = withEnvironmentForTest({
          AGENT_FRAMEWORK_ADAPTER: "codex",
          AGENT_FRAMEWORK_PROJECT_DIR: temporaryDir,
          AGENT_FRAMEWORK_SESSION_POLICY: "none",
          AGENT_FRAMEWORK_VOLATILE_DIR: path.join(temporaryDir, "session"),
        });
        const base = {
          session_id: `prompt-occurrence-${state}`,
          transcript_path: transcriptPath,
          cwd: temporaryDir,
          prompt,
        };
        try {
          const runtime = createTestScenarioRuntime({ root: runtimeRoot });
          const first = { ...base, delivery_id: "delivery-1" };
          await dispatchUserPromptSubmit(first, codexEncoder, { runtime });
          const runId = (await runtime.listRuns())[0]!.runId;
          const afterFirst = await runtime.canonicalView(runId);

          await dispatchUserPromptSubmit(first, codexEncoder, { runtime });
          expect(await runtime.canonicalView(runId)).toEqual(afterFirst);

          await dispatchUserPromptSubmit({ ...base, delivery_id: "delivery-2" }, codexEncoder, { runtime });
          const afterSecond = await runtime.canonicalView(runId);
          expect(afterSecond.snapshot.conversation.filter((message) =>
            message.role === "user" && message.content === prompt
          )).toHaveLength(2);
          expect(afterSecond.records.filter((record) =>
            record.eventType === "extension.observed" &&
            record.payload.extensionId === "agent-framework.host" &&
            record.payload.event === "UserPromptSubmit"
          )).toHaveLength(2);

          await expect(dispatchUserPromptSubmit(base, codexEncoder, { runtime })).rejects.toThrow(
            "lacks a stable delivery_id or newly observed native message occurrence",
          );
        } finally {
          restoreEnvironment();
        }
      });
    },
  );
});
