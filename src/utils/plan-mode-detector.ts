import * as fs from "fs";

/**
 * Detect if plan mode is currently active by scanning transcript.
 * Plan mode is active if EnterPlanMode was called more recently than ExitPlanMode.
 *
 * @param transcriptPath - Path to the transcript file
 * @returns true if plan mode is active, false otherwise
 */
export function isPlanModeActive(transcriptPath: string): boolean {
  let fd: number | undefined;
  try {
    // Read only last 50KB instead of entire file (plan mode transitions are recent)
    const stats = fs.statSync(transcriptPath);
    const readSize = Math.min(stats.size, 50 * 1024);

    fd = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
    fs.closeSync(fd);
    fd = undefined;

    const content = buffer.toString("utf-8");

    // Scan for tool_use blocks with EnterPlanMode or ExitPlanMode
    const enterMatch = content.lastIndexOf('"name":"EnterPlanMode"');
    const exitMatch = content.lastIndexOf('"name":"ExitPlanMode"');

    if (enterMatch === -1) return false; // Never entered plan mode
    if (exitMatch === -1) return true; // Entered but never exited

    return enterMatch > exitMatch; // Active if enter is more recent
  } catch {
    // Can't read transcript - assume not in plan mode
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
    return false;
  }
}
