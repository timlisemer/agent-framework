import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendToolLog,
  formatToolDetail,
  readRecentToolLogPriorErrors,
} from "../../src/utils/session-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempSessionDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("formatToolDetail", () => {
  it("returns 'Edit <path>' for Edit tool", () => {
    expect(formatToolDetail("Edit", { file_path: "/src/main.ts" })).toBe("Edit /src/main.ts");
  });

  it("truncates long Bash commands to 80 chars with '...'", () => {
    const longCommand = "a".repeat(100);
    const result = formatToolDetail("Bash", { command: longCommand });
    expect(result).toHaveLength(83); // 80 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("does not truncate short Bash commands", () => {
    expect(formatToolDetail("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("returns 'Read <path>' for Read tool", () => {
    expect(formatToolDetail("Read", { file_path: "/tmp/file.txt" })).toBe("Read /tmp/file.txt");
  });

  it("returns 'Glob <pattern>' for Glob tool", () => {
    expect(formatToolDetail("Glob", { pattern: "**/*.ts" })).toBe("Glob **/*.ts");
  });

  it("returns 'Grep <pattern>' for Grep tool", () => {
    expect(formatToolDetail("Grep", { pattern: "TODO" })).toBe("Grep TODO");
  });

  it("returns 'Write <path>' for Write tool", () => {
    expect(formatToolDetail("Write", { file_path: "/src/new.ts" })).toBe("Write /src/new.ts");
  });

  it("returns tool name for unknown tool", () => {
    expect(formatToolDetail("CustomTool", { data: "value" })).toBe("CustomTool");
  });

  it("handles missing input fields with 'unknown'", () => {
    expect(formatToolDetail("Edit", {})).toBe("Edit unknown");
    expect(formatToolDetail("Bash", {})).toBe("");
  });
});

describe("readRecentToolLogPriorErrors", () => {
  it("ignores prior errors older than the latest user message timestamp", async () => {
    const sessionDir = tempSessionDir();
    await appendToolLog(sessionDir, {
      ts: 100,
      tool: "mcp-scenario_tester",
      status: "denied",
      gate: "prediction-block",
      reason: "previous denied tool",
      ms: 1,
    });

    expect(readRecentToolLogPriorErrors(sessionDir, 25, { sinceTs: 200 })).toEqual([]);
  });

  it("ignores prior errors when a successful tool call happened afterward", async () => {
    const sessionDir = tempSessionDir();
    await appendToolLog(sessionDir, {
      ts: 100,
      tool: "mcp-scenario_tester",
      status: "denied",
      gate: "prediction-block",
      reason: "previous denied tool",
      ms: 1,
    });
    await appendToolLog(sessionDir, {
      ts: 150,
      tool: "mcp-scenario_tester",
      status: "allowed",
      gate: "all-rules",
      ms: 1,
    });

    expect(readRecentToolLogPriorErrors(sessionDir, 25, {
      sinceTs: 1,
      onlyUnresolvedSinceSuccess: true,
    })).toEqual([]);
  });

  it("keeps errors after the latest successful tool call in the current user turn", async () => {
    const sessionDir = tempSessionDir();
    await appendToolLog(sessionDir, {
      ts: 100,
      tool: "Read",
      status: "allowed",
      gate: "all-rules",
      ms: 1,
    });
    await appendToolLog(sessionDir, {
      ts: 150,
      tool: "mcp-scenario_tester",
      status: "denied",
      gate: "prediction-block",
      reason: "current denied tool",
      ms: 1,
    });

    expect(readRecentToolLogPriorErrors(sessionDir, 25, {
      sinceTs: 1,
      onlyUnresolvedSinceSuccess: true,
    })).toEqual([
      expect.objectContaining({
        source: "tool-denial",
        tool: "mcp-scenario_tester",
        gate: "prediction-block",
      }),
    ]);
  });
});
