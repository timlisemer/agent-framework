import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  currentTurnAssistantState,
  detectParallelBatch,
  readRecentUserMessages,
  readRecentUserMessagesArray,
  readTranscriptExact,
  resolveActiveSlashCommandAllowedTools,
  userTurnFollowedByCompletedToolRoundtrip,
} from "../../src/utils/transcript.js";

describe("detectParallelBatch", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-batch-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeTranscript(entries: unknown[]): string {
    const filePath = path.join(tempDir, "transcript.jsonl");
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function assistantToolUse(id: string, name = "Agent") {
    return {
      message: {
        id: "msg_batch",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id,
            name,
            input: {},
          },
        ],
      },
    };
  }

  function codexFunctionCall(id: string, name = "spawn_agent", namespace = "") {
    return {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: id,
        name,
        namespace,
        arguments: "{}",
      },
    };
  }

  function userText(text: string) {
    return {
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    };
  }

  it("returns null for a solo tool_use (batchSize < 2)", async () => {
    const filePath = writeTranscript([
      userText("hi"),
      assistantToolUse("toolu_solo"),
    ]);
    const result = await detectParallelBatch(filePath, "toolu_solo");
    expect(result).toBeNull();
  });

  it("returns batch info with position 0 when leader fires for a 3-call batch", async () => {
    const filePath = writeTranscript([
      userText("run three plans"),
      assistantToolUse("toolu_p1"),
      assistantToolUse("toolu_p2"),
      assistantToolUse("toolu_p3"),
    ]);
    const result = await detectParallelBatch(filePath, "toolu_p1");
    expect(result).not.toBeNull();
    expect(result?.position).toBe(0);
    expect(result?.batchSize).toBe(3);
    expect(result?.leaderId).toBe("toolu_p1");
    expect(result?.allIds).toEqual(["toolu_p1", "toolu_p2", "toolu_p3"]);
  });

  it("returns batch info with position 1 when middle sibling fires", async () => {
    const filePath = writeTranscript([
      userText("run three plans"),
      assistantToolUse("toolu_p1"),
      assistantToolUse("toolu_p2"),
      assistantToolUse("toolu_p3"),
    ]);
    const result = await detectParallelBatch(filePath, "toolu_p2");
    expect(result).not.toBeNull();
    expect(result?.position).toBe(1);
    expect(result?.batchSize).toBe(3);
    expect(result?.leaderId).toBe("toolu_p1");
  });

  it("returns batch info with position 2 when last sibling fires", async () => {
    const filePath = writeTranscript([
      userText("run three plans"),
      assistantToolUse("toolu_p1"),
      assistantToolUse("toolu_p2"),
      assistantToolUse("toolu_p3"),
    ]);
    const result = await detectParallelBatch(filePath, "toolu_p3");
    expect(result).not.toBeNull();
    expect(result?.position).toBe(2);
    expect(result?.batchSize).toBe(3);
  });

  it("skips a thinking-only assistant line between tool_uses", async () => {
    const filePath = writeTranscript([
      userText("run two plans"),
      {
        message: {
          id: "msg_batch",
          role: "assistant",
          content: [{ type: "thinking", thinking: "planning..." }],
        },
      },
      assistantToolUse("toolu_p1"),
      assistantToolUse("toolu_p2"),
    ]);
    const result = await detectParallelBatch(filePath, "toolu_p2");
    expect(result).not.toBeNull();
    expect(result?.batchSize).toBe(2);
    expect(result?.allIds).toEqual(["toolu_p1", "toolu_p2"]);
  });

  it("skips non-message metadata entries (e.g. summary lines without `message`)", async () => {
    const filePath = writeTranscript([
      userText("run two plans"),
      assistantToolUse("toolu_p1"),
      { type: "summary", summary: "interim", leafUuid: "abc" },
      assistantToolUse("toolu_p2"),
    ]);
    const result = await detectParallelBatch(filePath, "toolu_p2");
    expect(result).not.toBeNull();
    expect(result?.batchSize).toBe(2);
    expect(result?.allIds).toEqual(["toolu_p1", "toolu_p2"]);
  });

  it("breaks the back-walk on a text-only assistant line and excludes earlier tool_uses", async () => {
    const filePath = writeTranscript([
      userText("first"),
      assistantToolUse("toolu_prior"),
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "intermediate response" }],
        },
      },
      assistantToolUse("toolu_p1"),
      assistantToolUse("toolu_p2"),
    ]);
    const result = await detectParallelBatch(filePath, "toolu_p2");
    expect(result).not.toBeNull();
    expect(result?.allIds).toEqual(["toolu_p1", "toolu_p2"]);
  });

  it("breaks the back-walk on a tool_result (user-role) entry", async () => {
    const filePath = writeTranscript([
      userText("first"),
      assistantToolUse("toolu_prior"),
      {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_prior",
              content: "ok",
            },
          ],
        },
      },
      assistantToolUse("toolu_p1"),
      assistantToolUse("toolu_p2"),
    ]);
    const result = await detectParallelBatch(filePath, "toolu_p2");
    expect(result).not.toBeNull();
    expect(result?.allIds).toEqual(["toolu_p1", "toolu_p2"]);
  });

  // Live race: when the model emits a parallel tool_use batch, each
  // PreToolUse hook fires with the firing tool_use_id in input. The jsonl
  // transcript writes are an asynchronous side effect — the firing line
  // for a sibling may not be flushed to disk yet when its hook process
  // reads the transcript. Without retroactive detection, the function
  // returns null and pre-tool-use.ts treats the call as solo, bypassing
  // the leader's deny in the sibling-mirror path. The fix is to detect
  // the trailing run of consecutive assistant tool_use lines as an
  // in-flight batch and treat the firing call as its next sibling.
  it("treats the firing tool_use_id as a sibling when its line is not yet flushed (live race)", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "claude";
    try {
      const filePath = writeTranscript([
        userText("run three plans"),
        assistantToolUse("toolu_p1"),
        assistantToolUse("toolu_p2"),
        // toolu_p3 line not yet flushed when hook fires for it
      ]);
      const result = await detectParallelBatch(filePath, "toolu_p3");
      expect(result).not.toBeNull();
      expect(result?.batchSize).toBe(3);
      expect(result?.leaderId).toBe("toolu_p1");
      expect(result?.allIds).toContain("toolu_p3");
      expect(result?.allIds[0]).toBe("toolu_p1");
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_FRAMEWORK_ADAPTER;
      } else {
        process.env.AGENT_FRAMEWORK_ADAPTER = prev;
      }
    }
  });

  it("returns null in the race fallback when the trailing entry is a user message (no in-flight batch)", async () => {
    const filePath = writeTranscript([
      userText("first"),
      assistantToolUse("toolu_old"),
      {
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_old", content: "ok" },
          ],
        },
      },
      userText("next prompt"),
    ]);
    const result = await detectParallelBatch(filePath, "toolu_brand_new");
    expect(result).toBeNull();
  });

  it("returns null in the race fallback when the trailing entry is a tool_result", async () => {
    const filePath = writeTranscript([
      userText("first"),
      assistantToolUse("toolu_old"),
      {
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_old", content: "ok" },
          ],
        },
      },
    ]);
    const result = await detectParallelBatch(filePath, "toolu_brand_new");
    expect(result).toBeNull();
  });

  it("returns null in the race fallback when the trailing entry is a text-only assistant message", async () => {
    const filePath = writeTranscript([
      userText("first"),
      assistantToolUse("toolu_old"),
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "thinking out loud" }],
        },
      },
    ]);
    const result = await detectParallelBatch(filePath, "toolu_brand_new");
    expect(result).toBeNull();
  });

  it("returns null when the transcript is empty", async () => {
    const filePath = writeTranscript([]);
    const result = await detectParallelBatch(filePath, "toolu_anything");
    expect(result).toBeNull();
  });

  it("ignores malformed jsonl lines without crashing", async () => {
    const filePath = path.join(tempDir, "transcript.jsonl");
    const lines = [
      JSON.stringify(userText("hi")),
      "{not valid json",
      JSON.stringify(assistantToolUse("toolu_p1")),
      JSON.stringify(assistantToolUse("toolu_p2")),
    ];
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    const result = await detectParallelBatch(filePath, "toolu_p2");
    expect(result).not.toBeNull();
    expect(result?.allIds).toEqual(["toolu_p1", "toolu_p2"]);
  });

  it("detects batches from Codex rollout-shaped function calls", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      const filePath = writeTranscript([
        userText("run two agents"),
        codexFunctionCall("call_p1", "spawn_agent"),
        codexFunctionCall("call_p2", "spawn_agent"),
      ]);
      const result = await detectParallelBatch(filePath, "call_p2");
      expect(result).not.toBeNull();
      expect(result?.allIds).toEqual(["call_p1", "call_p2"]);
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_FRAMEWORK_ADAPTER;
      } else {
        process.env.AGENT_FRAMEWORK_ADAPTER = prev;
      }
    }
  });

  it("does not treat a nested Codex exec tool as an unflushed transcript sibling", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      const filePath = writeTranscript([
        userText("read the skill"),
        codexFunctionCall("call_outer_exec", "exec"),
      ]);
      const result = await detectParallelBatch(
        filePath,
        "exec-7007897d-f958-4670-b5fb-5d436f12dc78",
      );
      expect(result).toBeNull();
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_FRAMEWORK_ADAPTER;
      } else {
        process.env.AGENT_FRAMEWORK_ADAPTER = prev;
      }
    }
  });
});

describe("currentTurnAssistantState", () => {
  let tempDir: string;
  let prevAdapter: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-current-turn-test-"));
    prevAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;
    delete process.env.AGENT_FRAMEWORK_ADAPTER;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (prevAdapter === undefined) {
      delete process.env.AGENT_FRAMEWORK_ADAPTER;
    } else {
      process.env.AGENT_FRAMEWORK_ADAPTER = prevAdapter;
    }
  });

  function writeTranscript(entries: unknown[]): string {
    const filePath = path.join(tempDir, "transcript.jsonl");
    const content = entries.map((e) => typeof e === "string" ? e : JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function userText(text: string) {
    return {
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    };
  }

  function toolResult(toolUseId: string, content = "done") {
    return {
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
      },
    };
  }

  function assistantText(id: string, text: string, isMeta = false) {
    return {
      isMeta,
      message: {
        id,
        role: "assistant",
        content: [{ type: "text", text }],
      },
    };
  }

  function assistantToolUse(id: string, toolUseId: string, name = "Bash") {
    return {
      message: {
        id,
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name, input: {} }],
      },
    };
  }

  function codexEventAgentMessage(text: string) {
    return {
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: text,
        phase: "commentary",
      },
    };
  }

  function codexAssistantMessage(text: string) {
    return {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
        phase: "commentary",
      },
    };
  }

  function codexFunctionCall(id: string, name = "exec_command") {
    return {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: id,
        name,
        arguments: "{}",
      },
    };
  }

  function codexFunctionCallOutput(id: string, output = "done") {
    return {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: id,
        output,
      },
    };
  }

  it("treats adjacent distinct-id assistant text and tool_use entries as one responded turn", async () => {
    const filePath = writeTranscript([
      userText("please dont ignore the Raspberry Pi bootloader removal"),
      assistantText("msg_text", "You're right. I will use U-Boot/extlinux instead."),
      assistantToolUse("msg_tools", "call_read_flake"),
    ]);

    const result = await currentTurnAssistantState(filePath, "call_read_flake");

    expect(result).toEqual({
      kind: "responded",
      text: "You're right. I will use U-Boot/extlinux instead.",
      toolUseIds: ["call_read_flake"],
    });
  });

  it("keeps a tool-only assistant turn silent", async () => {
    const filePath = writeTranscript([
      userText("answer first"),
      assistantToolUse("msg_tools", "call_search"),
    ]);

    const result = await currentTurnAssistantState(filePath, "call_search");

    expect(result).toEqual({
      kind: "silent",
      toolUseIds: ["call_search"],
    });
  });

  it("does not leak a reused message id across separate user turns", async () => {
    const filePath = writeTranscript([
      userText("first prompt"),
      assistantText("msg_reused", "Answer to the first prompt."),
      userText("second prompt"),
      assistantToolUse("msg_reused", "call_second"),
    ]);

    const result = await currentTurnAssistantState(filePath, "call_second");

    expect(result).toEqual({
      kind: "silent",
      toolUseIds: ["call_second"],
    });
  });

  it("keeps assistant text across a tool_result boundary in the same human turn", async () => {
    const filePath = writeTranscript([
      userText("run this"),
      assistantText("msg_text", "Running it now."),
      toolResult("call_previous"),
      assistantToolUse("msg_tools", "call_followup"),
    ]);

    const result = await currentTurnAssistantState(filePath, "call_followup");

    expect(result).toEqual({
      kind: "responded",
      text: "Running it now.",
      toolUseIds: ["call_followup"],
    });
  });

  it("counts Codex event_msg agent_message before a tool call as assistant text", async () => {
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    const filePath = writeTranscript([
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: "inspect this" },
      },
      codexEventAgentMessage("I will inspect the relevant files read-only."),
      codexFunctionCall("call_inspect"),
    ]);

    const result = await currentTurnAssistantState(filePath, "call_inspect");

    expect(result).toEqual({
      kind: "responded",
      text: "I will inspect the relevant files read-only.",
      toolUseIds: ["call_inspect"],
    });
  });

  it("deduplicates paired Codex event_msg and assistant response_item text before a tool call", async () => {
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    const text = "I will inspect the relevant files read-only.";
    const filePath = writeTranscript([
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: "inspect this" },
      },
      codexEventAgentMessage(text),
      codexAssistantMessage(text),
      codexFunctionCall("call_inspect"),
    ]);

    const result = await currentTurnAssistantState(filePath, "call_inspect");

    expect(result).toEqual({
      kind: "responded",
      text,
      toolUseIds: ["call_inspect"],
    });
  });

  it("does not let Codex function_call_output reset prior assistant text", async () => {
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    const filePath = writeTranscript([
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: "inspect this" },
      },
      codexEventAgentMessage("I will inspect the relevant files read-only."),
      codexFunctionCall("call_plan", "update_plan"),
      codexFunctionCallOutput("call_plan", "Plan updated"),
      codexFunctionCall("call_inspect"),
    ]);

    const result = await currentTurnAssistantState(filePath, "call_inspect");

    expect(result).toEqual({
      kind: "responded",
      text: "I will inspect the relevant files read-only.",
      toolUseIds: ["call_plan", "call_inspect"],
    });
  });

  it("ignores malformed and meta lines without breaking an assistant run", async () => {
    const filePath = writeTranscript([
      userText("inspect this"),
      assistantText("msg_text", "Checking the relevant files."),
      "{not valid json",
      { isMeta: true },
      assistantText("msg_meta", "hidden metadata", true),
      assistantToolUse("msg_tools", "call_inspect"),
    ]);

    const result = await currentTurnAssistantState(filePath, "call_inspect");

    expect(result).toEqual({
      kind: "responded",
      text: "Checking the relevant files.",
      toolUseIds: ["call_inspect"],
    });
  });

  it("readTranscriptExact collects adjacent distinct-id assistant text entries as one message", async () => {
    const filePath = writeTranscript([
      userText("summarize"),
      assistantText("msg_text_1", "First visible sentence."),
      assistantText("msg_text_2", "Second visible sentence."),
    ]);

    const result = await readTranscriptExact(filePath, {
      counts: { user: 1, assistant: 1 },
    });

    expect(result.assistant).toEqual([
      {
        role: "assistant",
        content: "First visible sentence. Second visible sentence.",
        index: 2,
      },
    ]);
  });

  it("readTranscriptExact returns newest atomic assistant text candidates within the assistant bound", async () => {
    const filePath = writeTranscript([
      userText("start"),
      assistantText("msg_old", "Old assistant text."),
      assistantText("msg_mid", "Previous assistant text."),
      assistantText("msg_new", "Recent assistant text."),
    ]);

    const result = await readTranscriptExact(filePath, {
      counts: { user: 1, assistant: 2 },
    });

    expect(result.assistantTextCandidates).toEqual([
      "Recent assistant text.",
      "Previous assistant text.",
    ]);
  });

  it("readTranscriptExact keeps a Codex final proposed plan separate after tool output", async () => {
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    const planText = "<proposed_plan>\nPlan Name: codex-stop-regression\n\n## User Goal\nFix it.\n</proposed_plan>";
    const filePath = writeTranscript([
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: "plan the fix" },
      },
      codexEventAgentMessage("I will inspect the existing implementation first."),
      codexFunctionCall("call_inspect"),
      codexFunctionCallOutput("call_inspect", "inspection complete"),
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: planText }],
          phase: "final_answer",
        },
      },
    ]);

    const result = await readTranscriptExact(filePath, {
      counts: { user: 1, assistant: 1, tool: 1 },
    });

    expect(result.assistant).toEqual([
      {
        role: "assistant",
        content: planText,
        index: 3,
      },
    ]);
    expect(result.assistant[0].content).not.toContain("inspect the existing implementation");
  });
});

describe("resolveActiveSlashCommandAllowedTools", () => {
  let tempDir: string;
  let prevAdapter: string | undefined;

  beforeEach(() => {
    prevAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "claude";
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-slash-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (prevAdapter === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
    else process.env.AGENT_FRAMEWORK_ADAPTER = prevAdapter;
  });

  function writeTranscript(entries: unknown[]): string {
    const filePath = path.join(tempDir, "transcript.jsonl");
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function userText(text: string) {
    return {
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    };
  }

  function codexMessage(role: "user" | "assistant", text: string) {
    return {
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [
          {
            type: role === "user" ? "input_text" : "output_text",
            text,
          },
        ],
      },
    };
  }

  it("transcript with /plan3 tag -> returns plan3 workflow tools", async () => {
    const filePath = writeTranscript([
      userText("<command-name>/plan3</command-name>\nthats complete bullshit do not cheat"),
    ]);
    const result = await resolveActiveSlashCommandAllowedTools(filePath);
    expect(result).toEqual(["CloseAgent", "ExitPlanMode", "mcp-create_planfile", "mcp-validate_plan"]);
  });

  it("Codex rollout transcript with quickpush skill -> returns commit tools", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      const filePath = writeTranscript([
        codexMessage("user", "$agent-framework-quickpush"),
      ]);
      const result = await resolveActiveSlashCommandAllowedTools(filePath);
      expect(result).toEqual(["mcp-push", "mcp-commit"]);
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_FRAMEWORK_ADAPTER;
      } else {
        process.env.AGENT_FRAMEWORK_ADAPTER = prev;
      }
    }
  });

  it("readTranscriptExact marks newest direct slash prompt as slash command", async () => {
    const filePath = writeTranscript([
      userText("older normal prompt"),
      userText("/quickpush"),
    ]);

    const result = await readTranscriptExact(filePath, {
      counts: { user: 1 },
      excludeSlashCommandPrompts: true,
      includeSlashCommandContext: true,
    });
    expect(result.newestUserWasSlashCommand).toBe(true);
    expect(result.user).toHaveLength(1);
    expect(result.user[0].content).toBe("older normal prompt");
  });

  it("readTranscriptExact marks newest Codex skill prompt as slash command", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      const filePath = writeTranscript([
        userText("older normal prompt"),
        userText("$agent-framework-plan3"),
      ]);

      const result = await readTranscriptExact(filePath, {
        counts: { user: 1 },
        excludeSlashCommandPrompts: true,
        includeSlashCommandContext: true,
      });
      expect(result.newestUserWasSlashCommand).toBe(true);
      expect(result.slashCommandContext?.commandName).toBe("plan3");
      expect(result.user[0].content).toBe("older normal prompt");
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_FRAMEWORK_ADAPTER;
      } else {
        process.env.AGENT_FRAMEWORK_ADAPTER = prev;
      }
    }
  });

  it("readTranscriptExact infers fullconfirm from description-only frontmatter", async () => {
    const filePath = writeTranscript([
      userText([
        "---",
        "description: Run fullconfirm over the repository",
        "---",
        "",
        "Body without an explicit command name.",
      ].join("\n")),
    ]);

    const result = await readTranscriptExact(filePath, {
      counts: { user: 1 },
      includeSlashCommandContext: true,
    });

    expect(result.slashCommandContext?.commandName).toBe("fullconfirm");
  });

  it("readTranscriptExact recognizes Codex rollout-shaped skill prompts", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      const filePath = writeTranscript([
        codexMessage("user", "older normal prompt"),
        codexMessage("user", "$agent-framework-quickpush"),
        codexMessage("user", "<skill>\n<name>agent-framework-quickpush</name>\n</skill>"),
      ]);

      const result = await readTranscriptExact(filePath, {
        counts: { user: 1 },
        excludeSlashCommandPrompts: true,
        includeSlashCommandContext: true,
      });
      expect(result.newestUserWasSlashCommand).toBe(true);
      expect(result.slashCommandContext?.commandName).toBe("quickpush");
      expect(result.slashCommandContext?.allowedTools).toContain("mcp-commit");
      expect(result.slashCommandContext?.allowedTools).toContain("mcp-push");
      expect(result.user[0].content).toBe("older normal prompt");
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_FRAMEWORK_ADAPTER;
      } else {
        process.env.AGENT_FRAMEWORK_ADAPTER = prev;
      }
    }
  });

  it("keeps mixed Codex workflow prompts as latest user intent while excluding pure wrappers", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      const latest = "if you are happy now, please call $agent-framework-quickpush and iterate by editing files to fix complaints";
      const filePath = writeTranscript([
        codexMessage("user", "do not edit anything, just chat"),
        codexMessage("assistant", "I will only discuss it."),
        codexMessage("user", latest),
        codexMessage("user", "<skill>\n<name>agent-framework-quickpush</name>\n</skill>"),
      ]);

      const exact = await readTranscriptExact(filePath, {
        counts: { user: 2 },
        excludeSlashCommandPrompts: true,
        includeSlashCommandContext: true,
      });
      expect(exact.newestUserWasSlashCommand).toBe(true);
      expect(exact.slashCommandContext?.commandName).toBe("quickpush");
      expect(exact.user.map((m) => m.content)).toEqual([
        latest,
        "do not edit anything, just chat",
      ]);

      await expect(readRecentUserMessagesArray(filePath, 2, { stripQuoted: false })).resolves.toEqual([
        "do not edit anything, just chat",
        latest,
      ]);
      await expect(readRecentUserMessages(filePath, 2, false, { stripQuoted: false })).resolves.toBe(
        `do not edit anything, just chat\n---\n${latest}`,
      );
      await expect(userTurnFollowedByCompletedToolRoundtrip(filePath, latest)).resolves.toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_FRAMEWORK_ADAPTER;
      } else {
        process.env.AGENT_FRAMEWORK_ADAPTER = prev;
      }
    }
  });

  it("format context includes Codex rollout-shaped user and assistant messages", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      const filePath = writeTranscript([
        codexMessage("user", "$agent-framework-quickpush"),
        codexMessage("assistant", "Using quickpush now."),
      ]);

      const result = await readTranscriptExact(filePath, {
        counts: { user: 1, assistant: 1 },
        includeSlashCommandContext: true,
      });
      expect(result.user[0].content).toBe("$agent-framework-quickpush");
      expect(result.assistant[0].content).toBe("Using quickpush now.");
      expect(result.slashCommandContext?.commandName).toBe("quickpush");
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_FRAMEWORK_ADAPTER;
      } else {
        process.env.AGENT_FRAMEWORK_ADAPTER = prev;
      }
    }
  });

  it("transcript with /plan3 tag followed by non-tag user turn -> still returns plan3 tools", async () => {
    const filePath = writeTranscript([
      userText("<command-name>/plan3</command-name>\ndo the plan"),
      userText("ok continue"),
    ]);
    const result = await resolveActiveSlashCommandAllowedTools(filePath);
    // The backward scan finds "ok continue" first (no tag), then finds /plan3 tag
    expect(result).toEqual(["CloseAgent", "ExitPlanMode", "mcp-create_planfile", "mcp-validate_plan"]);
  });

  it("transcript with /plan3 then later /commit -> returns commit tools (most recent tag wins)", async () => {
    const filePath = writeTranscript([
      userText("<command-name>/plan3</command-name>\ndo the plan"),
      userText("ok continue"),
      userText("<command-name>/commit</command-name>\nnow commit"),
    ]);
    const result = await resolveActiveSlashCommandAllowedTools(filePath);
    expect(result).toEqual(["mcp-commit"]);
  });

  it("empty transcript -> returns undefined", async () => {
    const filePath = writeTranscript([]);
    const result = await resolveActiveSlashCommandAllowedTools(filePath);
    expect(result).toBeUndefined();
  });

  it("transcript with no tag -> returns undefined", async () => {
    const filePath = writeTranscript([
      userText("just a regular message"),
      userText("another message"),
    ]);
    const result = await resolveActiveSlashCommandAllowedTools(filePath);
    expect(result).toBeUndefined();
  });

  it("readRecentUserMessages preserves full quoted content when stripQuoted is false", async () => {
    const message = `${"context ".repeat(40)}\"edit src/foo.ts\"`;
    const filePath = writeTranscript([
      userText("older"),
      userText(message),
    ]);

    const result = await readRecentUserMessages(filePath, 1, false, { stripQuoted: false });
    expect(result).toBe(message);

    const arrayResult = await readRecentUserMessagesArray(filePath, 1, { stripQuoted: false });
    expect(arrayResult).toEqual([message]);
  });

  it("readRecentUserMessages keeps legacy stripped behavior by default", async () => {
    const filePath = writeTranscript([
      userText('please do this "quoted text"'),
    ]);
    await expect(readRecentUserMessages(filePath, 1)).resolves.toBe("please do this");
  });
});
