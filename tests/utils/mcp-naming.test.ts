import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const rawMcpWireNamePattern = /mcp__agent-framework__|mcp__agent_framework__/;
const sourceRoots = ["src", "adapters"];
const allowedSourceFiles = new Set([
  path.join("adapters", "claude", "recognize-mcp.ts"),
  path.join("adapters", "codex", "recognize-mcp.ts"),
  path.join("adapters", "claude", "prompt-strings.ts"),
  path.join("adapters", "codex", "prompt-strings.ts"),
]);

function collectTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
    } else if (entry.isFile() && fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("MCP naming", () => {
  it("does not hard-code adapter wire names outside adapter-owned rendering", () => {
    const violations = sourceRoots
      .flatMap((root) => collectTypeScriptFiles(root))
      .filter((file) => !allowedSourceFiles.has(file))
      .filter((file) => rawMcpWireNamePattern.test(fs.readFileSync(file, "utf-8")));

    expect(
      violations,
      "Use activeSpec().mcpWireName(...), mcpWireNameForText(...), or activeSpec().renderCheckMcpHint() instead of raw adapter wire MCP names.",
    ).toEqual([]);
  });
});
