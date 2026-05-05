/**
 * Claude adapter host context resolution.
 *
 * Knows about .claude paths, CLAUDE.md, and the Claude-specific memory dir.
 * No other module in src/ may reference these literals.
 *
 * @module adapters/claude/host-context
 */

import * as os from "os";
import * as path from "path";
import type { HostContext } from "../../src/adapter/types.js";

export function resolveHostContext(input: { cwd?: string }): HostContext {
  const projectDir =
    process.env.AGENT_FRAMEWORK_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR ||
    input.cwd ||
    process.cwd();

  const configRoot = path.join(os.homedir(), ".claude");
  const plansRoot = process.env.AGENT_FRAMEWORK_PLAN_DIR ?? path.join(configRoot, "plans");

  return {
    adapter: "claude",
    projectDir,
    configRoot,
    plansRoot,
    instructionFiles: [path.join(projectDir, "CLAUDE.md")],
    instructionLabel: "CLAUDE.md",
  };
}

export function isEditIntentExemptPath(filePath: string): boolean {
  if (filePath.includes("/.claude/plans/")) return true;
  // Memory files
  if (
    filePath.includes("/.claude/projects/") &&
    (filePath.includes("/memory/") || filePath.endsWith("MEMORY.md"))
  ) return true;
  // Host instruction files
  if (filePath.endsWith("CLAUDE.md")) return true;
  return false;
}
