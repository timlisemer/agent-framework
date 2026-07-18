import fsModule from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withCleanup } from "./resource-lifecycle.js";

const fs = fsModule.promises;

export type TemporaryDirectoryOptions = {
  prefix: string;
  parent?: string;
};

export function createTemporaryDirectory(options: TemporaryDirectoryOptions): Promise<string> {
  return fs.mkdtemp(path.join(options.parent ?? os.tmpdir(), options.prefix));
}

export function createTemporaryDirectorySync(options: TemporaryDirectoryOptions): string {
  return fsModule.mkdtempSync(path.join(options.parent ?? os.tmpdir(), options.prefix));
}

/** Run one operation in a fresh temporary directory and remove it with primary-error precedence. */
export async function withTemporaryDirectory<T>(
  options: TemporaryDirectoryOptions,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await createTemporaryDirectory(options);
  return withCleanup(
    () => operation(directory),
    () => fs.rm(directory, { recursive: true, force: true }),
  );
}

/** Synchronous counterpart to withTemporaryDirectory with the same failure precedence. */
export function withTemporaryDirectorySync<T>(
  options: TemporaryDirectoryOptions,
  operation: (directory: string) => T,
): T {
  const directory = createTemporaryDirectorySync(options);
  let result: { value: T } | null = null;
  let operationFailure: { error: unknown } | null = null;
  try {
    result = { value: operation(directory) };
  } catch (error) {
    operationFailure = { error };
  }
  let cleanupFailure: { error: unknown } | null = null;
  try {
    fsModule.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure = { error };
  }
  if (operationFailure) throw operationFailure.error;
  if (cleanupFailure) throw cleanupFailure.error;
  return result!.value;
}
