import type * as fs from "fs";

/** Make a test file handle fail after the requested number of successful reads. */
export function failFileHandleReadAfter(
  handle: fs.promises.FileHandle,
  successfulReads: number,
  error: Error = new Error("simulated read failure"),
): void {
  const originalRead = handle.read.bind(handle);
  let completedReads = 0;
  handle.read = (async (...args: Parameters<typeof handle.read>) => {
    if (completedReads === successfulReads) throw error;
    const result = await originalRead(...args);
    completedReads += 1;
    return result;
  }) as typeof handle.read;
}
