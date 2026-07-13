/**
 * Codex adapter host context resolution.
 *
 * Knows about .codex paths, AGENTS.md and CLAUDE.md instruction files.
 * No other module in src/ may reference these literals.
 *
 * @module adapters/codex/host-context
 */

import * as path from "path";
import type { HostContext, HostContextInput } from "../../src/adapter/types.js";
import { resolveBaseHostContext } from "../shared/host-context.js";

export function resolveHostContext(input: HostContextInput): HostContext {
  const { projectDir, configRoot, plansRoot } = resolveBaseHostContext(input, ".codex");

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
