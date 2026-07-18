import fsModule from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import { canonicalJsonEqual } from "../protocol/canonical-json.js";
import {
  isAlreadyExistsFileError,
  isFileSystemErrorCode,
  isMissingFileError,
} from "../../utils/filesystem-errors.js";
import { errorMessage } from "../../utils/output.js";
import { artifactRefSchema } from "../protocol/artifacts.js";
import { feedbackEntrySchema, type FeedbackEntry } from "../protocol/feedback.js";
import { scenarioRecordSchema, type ScenarioRecord } from "../protocol/records.js";
import { scenarioSnapshotSchema, type ScenarioSnapshot } from "../protocol/snapshot.js";
import {
  emptyScenarioSnapshot,
  reduceScenarioRecords,
  scenarioJournalRevision,
} from "../runtime/reducer.js";
import { pathExists, writeJsonAtomically } from "../../utils/file-io.js";
import { withCleanup } from "../../utils/resource-lifecycle.js";
import { appendScenarioRecords, readScenarioJournal, truncateScenarioJournal } from "./journal.js";
import {
  appendFeedbackEntry,
  readFeedbackStream,
  truncateFeedbackStream,
} from "./feedback-store.js";
import {
  withAcquiredRunLock,
  type RunLock,
  type RunLockOptions,
} from "./lock.js";
import {
  canonicalRunDir,
  canonicalRunsRoot,
  runJournalPath,
  runManifestPath,
  runSnapshotPath,
  runFeedbackPath,
  runArtifactsDir,
} from "./paths.js";
import { readScenarioSnapshot, writeScenarioSnapshot } from "./snapshot-store.js";
import { ArtifactStore } from "./artifact-store.js";
import { runManifestSchema, type RunManifest } from "./types.js";
import { isPathAtOrInside } from "../../utils/path-containment.js";

const fs = fsModule.promises;

export type OpenRun = {
  manifest: RunManifest;
  snapshot: ScenarioSnapshot;
  records: ScenarioRecord[];
  diagnostics: string[];
};

export type OpenRunResult = {
  run: OpenRun;
  committedBatches: CommittedRunBatch[];
};

export type CommittedRunBatch = {
  records: ScenarioRecord[];
  baseSnapshotRevision: number;
  resultingSnapshotRevision: number;
  snapshot: ScenarioSnapshot;
};

export type RunStoreTransactionResult<T> = {
  value: T;
  snapshot: ScenarioSnapshot;
  diagnostics: string[];
  committedBatches: CommittedRunBatch[];
};

export type RunStoreTransactionProposal<T> = {
  records: ScenarioRecord[];
  manifest?: RunManifest;
  feedback?: FeedbackEntry;
  value: T;
};

export class RunStore {
  public constructor(
    private readonly root: string,
    private readonly lockOptions?: RunLockOptions,
  ) {}

  public runDir(runId: string): string {
    return canonicalRunDir(runId, this.root);
  }

  public async exists(runId: string): Promise<boolean> {
    if (!(await this.validateRunDirectory(runId))) return false;
    return pathExists(runManifestPath(runId, this.root));
  }

  public async create(manifest: RunManifest, snapshot: ScenarioSnapshot): Promise<void> {
    const parsedManifest = runManifestSchema.parse(manifest);
    const parsedSnapshot = scenarioSnapshotSchema.parse(snapshot);
    if (parsedSnapshot.runId !== parsedManifest.runId) throw new Error("Run snapshot run mismatch");
    await this.publishCreatedRun(parsedManifest, parsedSnapshot, []);
  }

  /**
   * Create a run from canonical fixture/import state. Seed records remain the
   * authoritative history; an optional snapshot is a test/import checkpoint.
   */
  public async createSeeded(
    manifestInput: RunManifest,
    records: readonly ScenarioRecord[],
    snapshotInput?: ScenarioSnapshot,
  ): Promise<ScenarioSnapshot> {
    const manifest = runManifestSchema.parse(manifestInput);
    const parsedRecords = records.map((record) => scenarioRecordSchema.parse(record));
    for (const [index, record] of parsedRecords.entries()) {
      if (record.runId !== manifest.runId) throw new Error(`Seed record run mismatch at index ${index}`);
      if (record.recordSeq !== index + 1) throw new Error(`Seed record sequence mismatch at index ${index}`);
    }
    const authoritativeSnapshot = reduceScenarioRecords(
      emptyScenarioSnapshot(manifest),
      parsedRecords,
      scenarioJournalRevision(parsedRecords),
    );
    const snapshot = snapshotInput
      ? scenarioSnapshotSchema.parse(snapshotInput)
      : authoritativeSnapshot;
    if (snapshot.runId !== manifest.runId) throw new Error("Seed snapshot run mismatch");
    if (snapshot.lastRecordSeq !== parsedRecords.length) {
      throw new Error(`Seed snapshot cursor mismatch: ${snapshot.lastRecordSeq} != ${parsedRecords.length}`);
    }
    if (snapshotInput && !canonicalJsonEqual(snapshot, authoritativeSnapshot)) {
      throw new Error("Seed snapshot does not match the authoritative journal reduction");
    }
    const seededManifest = manifestFromSnapshot(manifest, authoritativeSnapshot);
    await this.publishCreatedRun(seededManifest, snapshot, parsedRecords);
    return snapshot;
  }

  private async publishCreatedRun(
    manifest: RunManifest,
    snapshot: ScenarioSnapshot,
    records: readonly ScenarioRecord[],
  ): Promise<void> {
    const runsRoot = canonicalRunsRoot(this.root);
    const storageRoot = path.dirname(runsRoot);
    const stagingRoot = path.join(storageRoot, ".run-staging");
    const stagingDir = path.join(stagingRoot, `${manifest.runId}-${randomUUID()}`);
    const destination = this.runDir(manifest.runId);
    let published = false;
    await withAcquiredRunLock(
      path.join(storageRoot, ".run-creation"),
      () => withCleanup(async () => {
        if (await pathExists(destination)) throw new Error(`Run already exists: ${manifest.runId}`);
        await fs.mkdir(runsRoot, { recursive: true });
        await fs.mkdir(stagingRoot, { recursive: true });
        await fs.mkdir(stagingDir);
        await writeJsonAtomically(path.join(stagingDir, "manifest.json"), manifest);
        if (records.length > 0) {
          await appendScenarioRecords(path.join(stagingDir, "scenario.records.jsonl"), records);
        }
        await writeScenarioSnapshot(path.join(stagingDir, "scenario.snapshot.json"), snapshot);
        try {
          await fs.rename(stagingDir, destination);
        } catch (error) {
          if (isAlreadyExistsFileError(error) || isFileSystemErrorCode(error, "ENOTEMPTY")) {
            throw new Error(`Run already exists: ${manifest.runId}`, { cause: error });
          }
          throw error;
        }
        published = true;
      }, async () => {
        if (!published) await fs.rm(stagingDir, { recursive: true, force: true });
      }),
      this.lockOptions,
    );
  }

  public async open(runId: string): Promise<OpenRunResult> {
    return this.withRunLock(runId, async (lock) => {
      const opened = await this.openUnlocked(runId);
      const committedBatches = [...opened.committedBatches];
      const acquisitionDiagnostics = [...lock.diagnostics];
      const acquisitionBatch = await this.recordRunLockAcquisitionDiagnostics(
        opened.run,
        acquisitionDiagnostics,
      );
      if (acquisitionBatch) committedBatches.push(acquisitionBatch);
      const finalBatch = await this.finalizeRunLockDiagnostics(
        opened.run,
        lock,
        acquisitionDiagnostics,
      );
      if (finalBatch) committedBatches.push(finalBatch);
      return { run: opened.run, committedBatches };
    });
  }

  private async openUnlocked(runId: string): Promise<{
    run: OpenRun;
    committedBatches: CommittedRunBatch[];
  }> {
    const committedBatches: CommittedRunBatch[] = [];
    let manifest = runManifestSchema.parse(JSON.parse(await fs.readFile(runManifestPath(runId, this.root), "utf8")));
    const journal = await readScenarioJournal(runJournalPath(runId, this.root));
    let storedSnapshot: ScenarioSnapshot | null = null;
    let manifestNeedsWrite = false;
    const diagnostics = [...journal.diagnostics];
    const recoveryReasons = [...journal.diagnostics];
    const artifactDiagnostics = await this.reconcileArtifacts(runId, journal.records);
    diagnostics.push(...artifactDiagnostics);
    recoveryReasons.push(...artifactDiagnostics);
    try {
      storedSnapshot = await readScenarioSnapshot(runSnapshotPath(runId, this.root));
      if (!storedSnapshot) recoveryReasons.push("Recovered a missing snapshot from the canonical journal");
    } catch (error) {
      recoveryReasons.push(`Recovered a corrupt snapshot from the canonical journal: ${errorMessage(error)}`);
    }
    if (journal.diagnostics.length > 0) {
      await truncateScenarioJournal(runJournalPath(runId, this.root), journal.validByteLength);
    }
    const replayRevision = scenarioJournalRevision(journal.records);
    let snapshot = reduceScenarioRecords(emptyScenarioSnapshot(manifest), journal.records, replayRevision);
    if (storedSnapshot && !snapshotsEqual(snapshot, storedSnapshot)) {
      recoveryReasons.push(
        `Recovered snapshot from canonical journal after semantic or cursor mismatch (${snapshotMismatchSummary(snapshot, storedSnapshot)})`,
      );
    } else if (storedSnapshot) {
      snapshot = storedSnapshot;
    }
    const journalManifest = manifestFromSnapshot(manifest, snapshot);
    if (!isDeepStrictEqual(manifest, journalManifest)) {
      recoveryReasons.push("Recovered stale run manifest from the canonical journal");
      manifest = journalManifest;
      manifestNeedsWrite = true;
    }
    const records = [...journal.records];
    if (recoveryReasons.length > 0) {
      const message = [...new Set(recoveryReasons)].join("; ");
      const recoveryRecord: ScenarioRecord = {
        runId,
        recordSeq: records.length + 1,
        recordId: `recovery:${randomUUID()}`,
        recordedAt: new Date().toISOString(),
        commandId: `recovery:${randomUUID()}`,
        eventType: "recovery.completed",
        visibility: "localSensitive",
        payload: { message },
      };
      await appendScenarioRecords(runJournalPath(runId, this.root), [recoveryRecord]);
      records.push(recoveryRecord);
      const baseSnapshotRevision = snapshot.revision;
      snapshot = reduceScenarioRecords(snapshot, [recoveryRecord], snapshot.revision + 1);
      await writeScenarioSnapshot(runSnapshotPath(runId, this.root), snapshot);
      committedBatches.push({
        records: [recoveryRecord],
        baseSnapshotRevision,
        resultingSnapshotRevision: snapshot.revision,
        snapshot,
      });
      diagnostics.push(message);
    }
    diagnostics.push(...await this.reconcileFeedback(runId, records));
    const opened = { manifest, snapshot, records, diagnostics };
    const diagnosticBatch = await this.recordStoreDiagnosticsUnlocked(opened, diagnostics, "runStore");
    if (diagnosticBatch) committedBatches.push(diagnosticBatch);
    const finalManifest = manifestFromSnapshot(opened.manifest, opened.snapshot);
    if (!isDeepStrictEqual(opened.manifest, finalManifest)) {
      opened.manifest = finalManifest;
      manifestNeedsWrite = true;
    }
    if (manifestNeedsWrite) {
      await writeJsonAtomically(runManifestPath(runId, this.root), opened.manifest);
    }
    return { run: opened, committedBatches };
  }

  public async transact<T>(
    runId: string,
    callback: (run: OpenRun) => Promise<RunStoreTransactionProposal<T>>,
  ): Promise<RunStoreTransactionResult<T>> {
    return this.withRunLock(runId, async (lock) => {
      const opened = await this.openUnlocked(runId);
      const run = opened.run;
      const committedBatches = [...opened.committedBatches];
      const acquisitionDiagnostics = [...lock.diagnostics];
      const acquisitionBatch = await this.recordRunLockAcquisitionDiagnostics(run, acquisitionDiagnostics);
      if (acquisitionBatch) committedBatches.push(acquisitionBatch);
      const proposed = await callback(run);
      if (
        proposed.records.length === 0 &&
        proposed.manifest === undefined &&
        proposed.feedback === undefined
      ) {
        const finalBatch = await this.finalizeRunLockDiagnostics(run, lock, acquisitionDiagnostics);
        if (finalBatch) committedBatches.push(finalBatch);
        return {
          value: proposed.value,
          snapshot: run.snapshot,
          diagnostics: [...run.diagnostics],
          committedBatches,
        };
      }
      const baseSnapshotRevision = run.snapshot.revision;
      const snapshot = reduceScenarioRecords(run.snapshot, proposed.records, run.snapshot.revision + 1);
      await appendScenarioRecords(runJournalPath(runId, this.root), proposed.records);
      if (proposed.feedback) {
        await appendFeedbackEntry(runFeedbackPath(runId, this.root), proposed.feedback);
      }
      await writeScenarioSnapshot(runSnapshotPath(runId, this.root), snapshot);
      if (proposed.manifest) {
        await writeJsonAtomically(runManifestPath(runId, this.root), runManifestSchema.parse(proposed.manifest));
      }
      run.records.push(...proposed.records);
      run.snapshot = snapshot;
      if (proposed.manifest) run.manifest = proposed.manifest;
      if (proposed.records.length > 0) {
        committedBatches.push({
          records: [...proposed.records],
          baseSnapshotRevision,
          resultingSnapshotRevision: snapshot.revision,
          snapshot,
        });
      }
      const finalBatch = await this.finalizeRunLockDiagnostics(run, lock, acquisitionDiagnostics);
      if (finalBatch) committedBatches.push(finalBatch);
      return {
        value: proposed.value,
        snapshot: run.snapshot,
        diagnostics: [...run.diagnostics],
        committedBatches,
      };
    });
  }

  private async withRunLock<T>(
    runId: string,
    operation: (lock: RunLock) => Promise<T>,
  ): Promise<T> {
    await this.assertRunExists(runId);
    return withAcquiredRunLock(this.runDir(runId), operation, this.lockOptions);
  }

  private async assertRunExists(runId: string): Promise<void> {
    if (await this.exists(runId)) return;
    throw Object.assign(new Error(`Run does not exist: ${runId}`), { code: "ENOENT" });
  }

  private async validateRunDirectory(runId: string): Promise<boolean> {
    const runDir = this.runDir(runId);
    let stat;
    try {
      stat = await fs.lstat(runDir);
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Canonical run path is not a genuine directory: ${runId}`);
    }
    const [resolvedRoot, resolvedRun] = await Promise.all([
      fs.realpath(canonicalRunsRoot(this.root)),
      fs.realpath(runDir),
    ]);
    if (!isPathAtOrInside(resolvedRun, resolvedRoot)) {
      throw new Error(`Canonical run path escapes the runs root: ${runId}`);
    }
    return true;
  }

  private async reconcileFeedback(runId: string, records: readonly ScenarioRecord[]): Promise<string[]> {
    const canonical = records.flatMap((record) => {
      if (record.eventType !== "feedback.changed") return [];
      return [feedbackEntrySchema.parse(record.payload.feedback)];
    });
    if (canonical.length === 0) return [];
    const feedbackPath = runFeedbackPath(runId, this.root);
    const stream = await readFeedbackStream(feedbackPath);
    const diagnostics: string[] = [];
    if (stream.hadPartialTail) {
      await truncateFeedbackStream(feedbackPath, stream.validByteLength);
      diagnostics.push("Ignored a final partial feedback line");
    }
    const persistedIds = new Set(stream.entries.map((entry) => entry.feedbackId));
    const missing = canonical.filter((entry) => !persistedIds.has(entry.feedbackId));
    for (const entry of missing) await appendFeedbackEntry(feedbackPath, entry);
    if (missing.length > 0) diagnostics.push(`Recovered ${missing.length} feedback record(s) from the canonical journal`);
    return diagnostics;
  }

  private async reconcileArtifacts(runId: string, records: readonly ScenarioRecord[]): Promise<string[]> {
    const artifactsDir = runArtifactsDir(runId, this.root);
    const linkedReferences = new Map(records.flatMap((record) => {
      if (record.eventType !== "artifact.linked") return [];
      const artifact = artifactRefSchema.parse(record.payload.artifact);
      return [[artifact.artifactId, artifact] as const];
    }));
    const artifactStore = new ArtifactStore(artifactsDir);
    for (const artifact of linkedReferences.values()) {
      try {
        await artifactStore.get(artifact);
      } catch (error) {
        throw new Error(
          `Linked artifact integrity check failed for ${artifact.artifactId}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
    const entries = await artifactStore.entries();
    const unlinked = entries.filter((entry) => !linkedReferences.has(entry));
    await Promise.all(unlinked.map((entry) =>
      artifactStore.removeEntry(entry)
    ));
    return unlinked.length === 0
      ? []
      : [`Recovered ${unlinked.length} unlinked artifact file(s)`];
  }

  private async recordStoreDiagnosticsUnlocked(
    run: OpenRun,
    diagnostics: readonly string[],
    source: string,
  ): Promise<CommittedRunBatch | null> {
    const messages = [...new Set(diagnostics)].filter(Boolean);
    if (messages.length === 0) return null;
    const commandId = `store-diagnostic:${randomUUID()}`;
    const recordedAt = new Date().toISOString();
    const records = messages.map((message, index): ScenarioRecord => ({
      runId: run.manifest.runId,
      recordSeq: run.records.length + index + 1,
      recordId: `store-diagnostic:${randomUUID()}`,
      recordedAt,
      commandId,
      eventType: "store.diagnostic",
      entityRef: { kind: "stateSlice", id: "store.health" },
      visibility: "localSensitive",
      payload: {
        message,
        source,
        status: "recovered",
      },
    }));
    await appendScenarioRecords(runJournalPath(run.manifest.runId, this.root), records);
    run.records.push(...records);
    const baseSnapshotRevision = run.snapshot.revision;
    run.snapshot = reduceScenarioRecords(run.snapshot, records, run.snapshot.revision + 1);
    await writeScenarioSnapshot(runSnapshotPath(run.manifest.runId, this.root), run.snapshot);
    run.manifest = manifestFromSnapshot(run.manifest, run.snapshot);
    await writeJsonAtomically(runManifestPath(run.manifest.runId, this.root), run.manifest);
    return {
      records,
      baseSnapshotRevision,
      resultingSnapshotRevision: run.snapshot.revision,
      snapshot: run.snapshot,
    };
  }

  private async recordRunLockAcquisitionDiagnostics(
    run: OpenRun,
    acquisitionDiagnostics: readonly string[],
  ): Promise<CommittedRunBatch | null> {
    run.diagnostics.unshift(...acquisitionDiagnostics);
    return this.recordStoreDiagnosticsUnlocked(run, acquisitionDiagnostics, "runLock");
  }

  private async finalizeRunLockDiagnostics(
    run: OpenRun,
    lock: RunLock,
    acquisitionDiagnostics: readonly string[],
  ): Promise<CommittedRunBatch | null> {
    const finalDiagnostics = await lock.stopHeartbeat();
    const acquired = new Set(acquisitionDiagnostics);
    const lateDiagnostics = [...new Set(finalDiagnostics)].filter((message) => !acquired.has(message));
    run.diagnostics.unshift(...lateDiagnostics);
    return this.recordStoreDiagnosticsUnlocked(run, lateDiagnostics, "runLock");
  }
}

function manifestFromSnapshot(manifest: RunManifest, snapshot: ScenarioSnapshot): RunManifest {
  return runManifestSchema.parse({
    ...manifest,
    source: snapshot.manifest.source,
    workingDir: snapshot.identity.workingDir,
    projectDir: snapshot.identity.projectDir,
    adapter: snapshot.manifest.adapter,
    provider: snapshot.manifest.provider,
    nativeSessionIds: snapshot.manifest.nativeSessionIds,
    engineVersion: snapshot.identity.engineVersion,
    schemaDigest: snapshot.identity.schemaDigest,
    capabilities: snapshot.capabilities,
    storagePolicy: snapshot.manifest.storagePolicy,
    runtimeHome: snapshot.manifest.runtimeHome,
    configuration: snapshot.manifest.configuration,
    createdAt: snapshot.manifest.createdAt,
    updatedAt: snapshot.manifest.updatedAt,
    status: snapshot.status,
  });
}

function snapshotsEqual(left: ScenarioSnapshot, right: ScenarioSnapshot): boolean {
  return isDeepStrictEqual(left, right);
}

function snapshotMismatchSummary(left: ScenarioSnapshot, right: ScenarioSnapshot): string {
  const differing = Object.keys(left).filter((key) =>
    !canonicalJsonEqual(left[key as keyof ScenarioSnapshot], right[key as keyof ScenarioSnapshot])
  );
  const effectDetails = differing.includes("effects")
    ? left.effects.flatMap((effect, index) => {
        const stored = right.effects[index];
        if (!stored) return [`effects.${index}:missing`];
        return Object.keys(effect).filter((key) =>
          !canonicalJsonEqual(effect[key as keyof typeof effect], stored[key as keyof typeof stored])
        ).map((key) => `effects.${index}.${key}`);
      })
    : [];
  const details = [...differing, ...effectDetails];
  return details.length > 0 ? `differing fields: ${details.join(", ")}` : "serialization mismatch";
}
