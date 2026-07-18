import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isMissingFileError } from "../../src/utils/filesystem-errors.js";
import { writeFileAtomically } from "../../src/utils/file-io.js";

export async function synchronizeGeneratedFiles(options: {
  root: string;
  files: ReadonlyMap<string, string>;
  check: boolean;
  staleMessage: (relativePaths: readonly string[]) => string;
}): Promise<void> {
  const entries = [...options.files].sort(([left], [right]) => left.localeCompare(right));
  if (options.check) {
    const stale = (await Promise.all(entries.map(async ([relativePath, expected]) => {
      const actual = await fs.readFile(path.join(options.root, relativePath), "utf8").catch((error: unknown) => {
        if (isMissingFileError(error)) return null;
        throw error;
      });
      return actual === expected ? null : relativePath;
    }))).filter((relativePath): relativePath is string => relativePath !== null);
    if (stale.length > 0) throw new Error(options.staleMessage(stale));
    return;
  }
  await Promise.all(entries.map(async ([relativePath, contents]) => {
    const destination = path.join(options.root, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await writeFileAtomically(destination, contents);
  }));
}
