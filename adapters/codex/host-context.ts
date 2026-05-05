/**
 * Codex adapter host context resolution.
 *
 * Knows about .codex paths, AGENTS.md and CLAUDE.md instruction files.
 * No other module in src/ may reference these literals.
 *
 * @module adapters/codex/host-context
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

  const configRoot = path.join(os.homedir(), ".codex");
  const plansRoot = process.env.AGENT_FRAMEWORK_PLAN_DIR ?? path.join(configRoot, "plans");

  return {
    adapter: "codex",
    projectDir,
    configRoot,
    plansRoot,
    instructionFiles: [
      path.join(projectDir, "AGENTS.md"),
      path.join(projectDir, "CLAUDE.md"),
    ],
    instructionLabel: "AGENTS.md/CLAUDE.md",
  };
}

export function isEditIntentExemptPath(filePath: string): boolean {
  if (filePath.includes("/.codex/plans/")) return true;
  // Host instruction files
  if (filePath.endsWith("AGENTS.md")) return true;
  if (filePath.endsWith("CLAUDE.md")) return true;
  return false;
}
