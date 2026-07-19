import { describe, expect, it } from "vitest";
import { canonicalizeToolCall } from "../../adapters/codex/canonicalize-tool-call.js";

describe("Codex canonicalizeToolCall", () => {
  it("canonicalizes structured apply_patch file_paths from SDK events", () => {
    expect(canonicalizeToolCall("apply_patch", {
      file_paths: ["/repo/src/a.ts", "/repo/src/c.ts"],
    })).toEqual({
      toolName: "Edit",
      toolInput: {
        file_path: "/repo/src/a.ts",
        file_paths: ["/repo/src/a.ts", "/repo/src/c.ts"],
      },
    });
  });

  it("canonicalizes raw edit_file and write_file aliases", () => {
    expect(canonicalizeToolCall("edit_file", { file_path: "/repo/src/a.ts" })).toEqual({
      toolName: "Edit",
      toolInput: { file_path: "/repo/src/a.ts" },
    });
    expect(canonicalizeToolCall("write_file", { file_path: "/repo/src/b.ts" })).toEqual({
      toolName: "Write",
      toolInput: { file_path: "/repo/src/b.ts" },
    });
  });

  it("preserves exec_command structured argument boundaries", () => {
    expect(canonicalizeToolCall("exec_command", {
      command: "xargs",
      args: ["cat", "unrelated; cat /required-plan.md", "name with spaces", "literal | pipe"],
    })).toEqual({
      toolName: "Bash",
      toolInput: {
        command: "xargs cat 'unrelated; cat /required-plan.md' 'name with spaces' 'literal | pipe'",
      },
    });
    expect(canonicalizeToolCall("exec_command", {
      cmd: "sed -n '1,20p' plan.md",
      args: [],
    })).toEqual({
      toolName: "Bash",
      toolInput: { command: "sed -n '1,20p' plan.md" },
    });
    expect(canonicalizeToolCall("Bash", {
      command: "sed -n '1,20p' plan.md",
      args: [],
      workdir: "/repo",
    })).toEqual({
      toolName: "Bash",
      toolInput: { command: "sed -n '1,20p' plan.md" },
    });
    expect(canonicalizeToolCall("exec_command", {
      command: "head",
      args: ["-n", '1"0', "C:/plan.md"],
    })).toEqual({
      toolName: "Bash",
      toolInput: { command: `head -n '1"0' C:/plan.md` },
    });
  });

  it("canonicalizes namespaced and file-read aliases", () => {
    expect(canonicalizeToolCall("functions.read_file", { path: "/repo/README.md" })).toEqual({
      toolName: "Read",
      toolInput: { path: "/repo/README.md" },
    });
  });

  it("canonicalizes interactive PTY input as continuation shell work", () => {
    expect(canonicalizeToolCall("write_stdin", {
      session_id: 42,
      chars: "rm -rf ./generated\n",
      yield_time_ms: 1_000,
    })).toEqual({
      toolName: "Bash",
      toolInput: {
        command: "rm -rf ./generated\n",
        continuation_session_id: 42,
      },
    });
  });

  it("distinguishes MCP continuation waits from agent waits", () => {
    expect(canonicalizeToolCall("wait", { cell_id: "cell-1" })).toEqual({
      toolName: "Wait",
      toolInput: { cell_id: "cell-1" },
    });
    expect(canonicalizeToolCall("wait_agent", { target: "agent-1" })).toEqual({
      toolName: "TaskOutput",
      toolInput: { target: "agent-1", targets: ["agent-1"] },
    });
  });
});
