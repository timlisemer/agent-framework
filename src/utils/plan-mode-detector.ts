import * as fs from "fs";

/**
 * Detect if plan mode is currently active by scanning transcript.
 * Plan mode is active if EnterPlanMode was called more recently than ExitPlanMode.
 *
 * @param transcriptPath - Path to the transcript file
 * @returns true if plan mode is active, false otherwise
 */
export function isPlanModeActive(transcriptPath: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    // Can't read transcript - assume not in plan mode
    return false;
  }

  // Scan for tool_use blocks with EnterPlanMode or ExitPlanMode
  const enterMatch = content.lastIndexOf('"name":"EnterPlanMode"');
  const exitMatch = content.lastIndexOf('"name":"ExitPlanMode"');

  if (enterMatch === -1) return false; // Never entered plan mode
  if (exitMatch === -1) return true; // Entered but never exited

  return enterMatch > exitMatch; // Active if enter is more recent
}
