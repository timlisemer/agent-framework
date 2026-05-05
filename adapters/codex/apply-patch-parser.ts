/**
 * Codex apply_patch body parser.
 *
 * Extracts file paths from the apply_patch command body. This lives in the
 * Codex adapter because apply_patch is a Codex-specific wire tool that
 * canonicalizes to Edit. No file in src/ should reference apply_patch.
 *
 * @module adapters/codex/apply-patch-parser
 */

export function extractApplyPatchPaths(toolInput: unknown): string[] {
  const command = typeof toolInput === "string"
    ? toolInput
    : (toolInput as { command?: unknown; patch?: unknown } | undefined)?.command ??
      (toolInput as { patch?: unknown } | undefined)?.patch;
  if (typeof command !== "string") return [];
  const paths: string[] = [];
  for (const line of command.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match) paths.push(match[1].trim());
  }
  return [...new Set(paths)];
}
