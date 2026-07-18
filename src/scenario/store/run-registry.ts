import * as fs from "fs/promises";
import * as path from "path";
import type { Dirent } from "node:fs";
import { isMissingFileError } from "../../utils/filesystem-errors.js";
import { errorMessage } from "../../utils/output.js";
import { runManifestSchema, runRegistryEntrySchema, type RunManifest, type RunRegistryEntry } from "./types.js";
import { canonicalRunsRoot, runIndexPath } from "./paths.js";
import { withAcquiredRunLock } from "./lock.js";
import { appendValidatedJsonl } from "../../utils/file-io.js";

export type RunRegistryDiagnostic = {
  kind: "malformedRunDirectory" | "missingManifest" | "malformedManifest";
  runDirectory: string;
  manifestPath: string;
  reason: string;
};

export type RunRegistryInspection = {
  manifests: RunManifest[];
  diagnostics: RunRegistryDiagnostic[];
};

export class RunRegistryDiagnosticsError extends Error {
  public constructor(public readonly diagnostics: readonly RunRegistryDiagnostic[]) {
    super(`Run registry contains ${diagnostics.length} invalid run director${diagnostics.length === 1 ? "y" : "ies"}: ${
      diagnostics.map((diagnostic) => `${diagnostic.manifestPath}: ${diagnostic.reason}`).join("; ")
    }`);
    this.name = "RunRegistryDiagnosticsError";
  }
}

export class RunRegistry {
  public constructor(private readonly root: string) {}

  public async append(manifest: RunManifest, operation: RunRegistryEntry["operation"]): Promise<void> {
    const entry: RunRegistryEntry = {
      runId: manifest.runId,
      operation,
      status: manifest.status,
      source: manifest.source,
      workingDir: manifest.workingDir,
      updatedAt: manifest.updatedAt,
    };
    const index = runIndexPath(this.root);
    await fs.mkdir(path.dirname(index), { recursive: true });
    await withAcquiredRunLock(path.join(path.dirname(index), ".run-index"), async () => {
      await appendValidatedJsonl(index, runRegistryEntrySchema, [entry]);
    });
  }

  public async list(): Promise<RunManifest[]> {
    const inspection = await this.inspect();
    if (inspection.diagnostics.length > 0) throw new RunRegistryDiagnosticsError(inspection.diagnostics);
    return inspection.manifests;
  }

  public async inspect(): Promise<RunRegistryInspection> {
    const { manifests, diagnostics } = await this.readManifests();
    return {
      manifests: [...manifests.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      diagnostics,
    };
  }

  public async reconstruct(): Promise<RunManifest[]> {
    return this.list();
  }

  /** Resolve a provider/adapter-native session or transcript identifier. */
  public async findByNativeIdentifier(identifier: string): Promise<RunManifest | undefined> {
    return (await this.list()).find((manifest) =>
      manifest.nativeSessionIds.includes(identifier) ||
      ("nativeSessionId" in manifest.source && manifest.source.nativeSessionId === identifier)
    );
  }

  /** Rebuild append-only discovery entries from authoritative manifests. */
  public async repairIndex(): Promise<RunManifest[]> {
    const manifests = await this.list();
    for (const manifest of manifests) await this.append(manifest, "updated");
    return manifests;
  }

  private async readManifests(): Promise<{
    manifests: Map<string, RunManifest>;
    diagnostics: RunRegistryDiagnostic[];
  }> {
    const result = new Map<string, RunManifest>();
    const diagnostics: RunRegistryDiagnostic[] = [];
    let entries: Dirent[];
    try {
      entries = await fs.readdir(canonicalRunsRoot(this.root), { encoding: "utf8", withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return { manifests: result, diagnostics };
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      const runDirectory = path.join(canonicalRunsRoot(this.root), entry.name);
      const manifestPath = path.join(runDirectory, "manifest.json");
      if (!entry.isDirectory()) {
        diagnostics.push({
          kind: "malformedRunDirectory",
          runDirectory,
          manifestPath,
          reason: "Run registry entry is not a directory",
        });
        return;
      }
      let contents: string;
      try {
        contents = await fs.readFile(manifestPath, "utf8");
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
        diagnostics.push({
          kind: "missingManifest",
          runDirectory,
          manifestPath,
          reason: "Run manifest is missing",
        });
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(contents);
      } catch (error) {
        diagnostics.push({
          kind: "malformedManifest",
          runDirectory,
          manifestPath,
          reason: errorMessage(error),
        });
        return;
      }
      const parsed = runManifestSchema.safeParse(value);
      if (!parsed.success || parsed.data.runId !== entry.name) {
        diagnostics.push({
          kind: "malformedManifest",
          runDirectory,
          manifestPath,
          reason: parsed.success
            ? `Manifest runId ${JSON.stringify(parsed.data.runId)} does not match directory ${JSON.stringify(entry.name)}`
            : parsed.error.message,
        });
        return;
      }
      result.set(parsed.data.runId, parsed.data);
    }));
    diagnostics.sort((left, right) => left.manifestPath.localeCompare(right.manifestPath));
    return { manifests: result, diagnostics };
  }
}
