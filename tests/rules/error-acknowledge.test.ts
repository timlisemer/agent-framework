import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { errorAcknowledgeRule } from "../../src/rules/error-acknowledge.js";
import { activeSpec } from "../../src/adapter/spec.js";
import type { RuleContext } from "../../src/rules/types.js";
import { sessionStateDefaults } from "../../src/utils/session-store.js";
import { appendJsonlEntrySync } from "../../src/utils/file-io.js";

describe("errorAcknowledgeRule", () => {
  let tempDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "error-ack-test-"));
    transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeCtx(
    toolName = activeSpec().mcpWireName("commit"),
    toolInput: unknown = {},
  ): RuleContext {
    return {
      toolName,
      toolInput,
      toolUseId: "toolu_error_ack",
      projectDir: tempDir,
      transcriptPath,
      sessionDir: tempDir,
      sessionId: "session",
      state: sessionStateDefaults(),
      stateManager: {} as RuleContext["stateManager"],
      planMode: false,
      planModeCtx: { active: false, contextString: "" },
    };
  }

  function appendToolLog(entry: {
    tool: string;
    status: "allowed" | "denied";
    reason?: string;
    path?: string;
    paths?: string[];
  }): void {
    appendJsonlEntrySync(path.join(tempDir, "tool-log.jsonl"), {
      ts: Date.now(),
      toolUseId: `${entry.tool}-${entry.status}`,
      tool: entry.tool,
      status: entry.status,
      gate: "test",
      reason: entry.reason,
      path: entry.path,
      paths: entry.paths,
      ms: 1,
    });
  }

  it("ignores older denials after a sanctioned framework check passed", async () => {
    appendToolLog({
      tool: "Bash",
      status: "denied",
      reason: "test command is covered by the agent-framework check MCP (matched check target entry: vitest). You must run mcp__agent-framework__check",
    });
    appendToolLog({
      tool: activeSpec().mcpWireName("check"),
      status: "allowed",
    });

    await expect(errorAcknowledgeRule.check(makeCtx())).resolves.toBeNull();
  });

  it("ignores older denials after a sanctioned fullconfirm passed", async () => {
    appendToolLog({
      tool: "Bash",
      status: "denied",
      reason: "test command is covered by the agent-framework check MCP (matched check target entry: vitest). You must run mcp__agent-framework__check",
    });
    appendToolLog({
      tool: activeSpec().mcpWireName("fullconfirm"),
      status: "allowed",
    });

    await expect(errorAcknowledgeRule.check(makeCtx())).resolves.toBeNull();
  });

  it("still denies when the newest relevant event is an unresolved denial", async () => {
    appendToolLog({
      tool: activeSpec().mcpWireName("check"),
      status: "allowed",
    });
    appendToolLog({
      tool: "Bash",
      status: "denied",
      reason: "test command is covered by the agent-framework check MCP (matched check target entry: vitest). You must run mcp__agent-framework__check",
    });

    const result = await errorAcknowledgeRule.check(makeCtx());
    expect(result).toEqual({
      fastDeny: 'Previous tool "Bash" was denied: test command is covered by the agent-framework check MCP (matched check target entry: vitest). You must run mcp__agent-framework__check. You must acknowledge the error before proceeding with a different tool.',
    });
  });

  it("treats retries that include a previously denied path in any position as same-target corrections", async () => {
    const deniedPath = path.join(tempDir, "src", "denied.ts");
    appendToolLog({
      tool: "Edit",
      status: "denied",
      reason: "edit failed",
      paths: [path.join(tempDir, "src", "other.ts"), deniedPath],
    });

    await expect(errorAcknowledgeRule.check(makeCtx("Edit", {
      file_path: path.join(tempDir, "src", "first.ts"),
      file_paths: [path.join(tempDir, "src", "first.ts"), deniedPath],
    }))).resolves.toBeNull();
  });
});
