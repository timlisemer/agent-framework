import * as fs from "node:fs/promises";
import {
  createTemporaryDirectory,
  withTemporaryDirectory,
  withTemporaryDirectorySync,
} from "../../src/utils/temporary-directory.js";

/** Create and register one temporary test root for the owning suite's cleanup hook. */
export async function createTemporaryTestRoot(
  roots: string[],
  prefix = "agent-framework-scenario-test-",
): Promise<string> {
  const root = await createTemporaryDirectory({ prefix });
  roots.push(root);
  return root;
}

/** Clean every root registered by createTemporaryTestRoot and empty the collection. */
export async function cleanupTemporaryTestRoots(roots: string[]): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
}

/** Run one test body with an immediately cleaned temporary root. */
export async function withTemporaryTestRoot<T>(
  prefix: string,
  callback: (root: string) => Promise<T>,
): Promise<T> {
  return withTemporaryDirectory({ prefix }, callback);
}

/** Run one synchronous test body with an immediately cleaned temporary root. */
export function withTemporaryTestRootSync<T>(
  prefix: string,
  callback: (root: string) => T,
): T {
  return withTemporaryDirectorySync({ prefix }, callback);
}
