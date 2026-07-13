/**
 * Claude adapter host context resolution.
 *
 * Knows about .claude paths, CLAUDE.md, and the Claude-specific memory dir.
 * No other module in src/ may reference these literals.
 *
 * @module adapters/claude/host-context
 */

import * as path from "path";
import type { HostContext, HostContextInput } from "../../src/adapter/types.js";
import { resolveBaseHostContext } from "../shared/host-context.js";

export function resolveHostContext(input: HostContextInput): HostContext {
  const { projectDir, configRoot, plansRoot } = resolveBaseHostContext(input, ".claude");

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
