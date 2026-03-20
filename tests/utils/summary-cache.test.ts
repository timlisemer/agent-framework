import { describe, it, expect } from "vitest";
import { formatToolDetail } from "../../src/utils/summary-cache.js";

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
