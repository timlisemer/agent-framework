import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { detectParallelBatch, resolveActiveSlashCommandAllowedTools } from "../../src/utils/transcript.js";

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
});

describe("resolveActiveSlashCommandAllowedTools", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-slash-test-"));
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

  function userText(text: string) {
    return {
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    };
  }

  it("transcript with /plan3 tag -> returns ['Agent','ExitPlanMode']", async () => {
    const filePath = writeTranscript([
      userText("<command-name>/plan3</command-name>\nthats complete bullshit do not cheat"),
    ]);
    const result = await resolveActiveSlashCommandAllowedTools(filePath);
    expect(result).toEqual(["Agent", "ExitPlanMode"]);
  });

  it("transcript with /plan3 tag followed by non-tag user turn -> still returns plan3 tools", async () => {
    const filePath = writeTranscript([
      userText("<command-name>/plan3</command-name>\ndo the plan"),
      userText("ok continue"),
    ]);
    const result = await resolveActiveSlashCommandAllowedTools(filePath);
    // The backward scan finds "ok continue" first (no tag), then finds /plan3 tag
    expect(result).toEqual(["Agent", "ExitPlanMode"]);
  });

  it("transcript with /plan3 then later /commit -> returns commit tools (most recent tag wins)", async () => {
    const filePath = writeTranscript([
      userText("<command-name>/plan3</command-name>\ndo the plan"),
      userText("ok continue"),
      userText("<command-name>/commit</command-name>\nnow commit"),
    ]);
    const result = await resolveActiveSlashCommandAllowedTools(filePath);
    expect(result).toEqual(["mcp__agent-framework__commit", "mcp__agent_framework__commit"]);
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
});
