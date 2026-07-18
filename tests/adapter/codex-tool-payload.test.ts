import { describe, expect, it } from "vitest";
import {
  codexToolLogEntryMatchesToolCall,
  codexTranscriptToolLogIdentityKey,
  codexTranscriptToolLogMatchIsStable,
  extractCodexToolPaths,
} from "../../adapters/codex/tool-payload.js";
import type { ToolLogEntry } from "../../src/utils/tool-log-types.js";

describe("Codex tool payload helpers", () => {
  it("canonicalizes path fields with one sorted unique policy", () => {
    expect(extractCodexToolPaths({
      file_path: " src/b.ts ",
      file_paths: ["src/a.ts", "src/b.ts"],
      notebook_path: "src/notebook.ipynb",
    })).toEqual(["src/a.ts", "src/b.ts", "src/notebook.ipynb"]);
  });

  it("matches exec_command transcript tools to Bash logs by command", () => {
    expect(codexTranscriptToolLogIdentityKey(
      "exec_command",
      { command: "sed -n '1,20p' .env" }
    )).toBe("Bash:cmd:sed -n '1,20p' .env");
    expect(codexTranscriptToolLogMatchIsStable(
      "exec_command",
      { command: "sed -n '1,20p' .env" }
    )).toBe(true);
    expect(codexToolLogEntryMatchesToolCall(
      toolLog({ tool: "Bash", cmd: "sed -n '1,20p' .env" }),
      "exec_command",
      { command: "sed -n '1,20p' .env" }
    )).toBe(true);
    expect(codexToolLogEntryMatchesToolCall(
      toolLog({ tool: "Bash", cmd: "git status --short" }),
      "exec_command",
      { command: "sed -n '1,20p' .env" }
    )).toBe(false);
  });

  it("identifies write_stdin as continuation of canonical Bash work", () => {
    expect(codexTranscriptToolLogIdentityKey(
      "write_stdin",
      { session_id: 42, chars: "cargo test\n" },
    )).toBe("Bash:cmd:cargo test");
    expect(codexToolLogEntryMatchesToolCall(
      toolLog({ tool: "Bash", cmd: "cargo test" }),
      "write_stdin",
      { session_id: 42, chars: "cargo test\n" },
    )).toBe(true);
  });

  it("matches file tools by canonical full path list", () => {
    expect(codexTranscriptToolLogIdentityKey(
      "apply_patch",
      { file_paths: ["src/b.ts", "src/a.ts"] }
    )).toBe("Edit:paths:src/a.ts\0src/b.ts");
    expect(codexToolLogEntryMatchesToolCall(
      toolLog({ tool: "Read", path: "src/app.ts" }),
      "read_file",
      { file_path: "src/app.ts" }
    )).toBe(true);
    expect(codexToolLogEntryMatchesToolCall(
      toolLog({ tool: "Edit", paths: ["src/a.ts", "src/b.ts"] }),
      "edit_file",
      { file_paths: ["src/b.ts", "src/a.ts"] }
    )).toBe(true);
    expect(codexToolLogEntryMatchesToolCall(
      toolLog({ tool: "Edit", paths: ["src/a.ts", "src/b.ts"] }),
      "apply_patch",
      { file_paths: ["src/b.ts", "src/a.ts"] }
    )).toBe(true);
    expect(codexToolLogEntryMatchesToolCall(
      toolLog({ tool: "Edit", paths: ["src/a.ts", "src/b.ts"] }),
      "edit_file",
      { file_paths: ["src/a.ts"] }
    )).toBe(false);
  });

  it("marks pathless same-tool fallback as unstable", () => {
    expect(codexTranscriptToolLogMatchIsStable(
      "mcp__agent_framework__check",
      { working_dir: "/repo" }
    )).toBe(false);
    expect(codexToolLogEntryMatchesToolCall(
      toolLog({ tool: "mcp__agent_framework__commit" }),
      "mcp__agent_framework__check",
      { working_dir: "/repo" }
    )).toBe(false);
  });
});

function toolLog(input: Partial<ToolLogEntry> & Pick<ToolLogEntry, "tool">): ToolLogEntry {
  return {
    ts: 1,
    status: "allowed",
    gate: "test",
    ms: 1,
    ...input,
  };
}
