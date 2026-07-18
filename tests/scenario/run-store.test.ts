import fsModule from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FULL_RUN_CAPABILITIES } from "../../src/scenario/protocol/capabilities.js";
import type { ScenarioRecord } from "../../src/scenario/protocol/records.js";
import type { ScenarioCommand } from "../../src/scenario/protocol/commands.js";
import { scenarioProtocolSchemaDigest } from "../../src/scenario/protocol/schema.js";
import {
  emptyScenarioSnapshot,
  reduceScenarioRecords,
  scenarioJournalRevision,
} from "../../src/scenario/runtime/reducer.js";
import { createTestScenarioRuntime } from "../helpers/scenario-runtime.js";
import { testStartRunCommand } from "../helpers/scenario-fixtures.js";
import { writeJsonAtomically } from "../../src/utils/file-io.js";
import { ArtifactStore } from "../../src/scenario/store/artifact-store.js";
import { readScenarioJournal } from "../../src/scenario/store/journal.js";
import { readFeedbackStream } from "../../src/scenario/store/feedback-store.js";
import { acquireRunLock } from "../../src/scenario/store/lock.js";
import {
  canonicalRunDir,
  runIndexPath,
  runJournalPath,
  runManifestPath,
  runSnapshotPath,
  runArtifactsDir,
} from "../../src/scenario/store/paths.js";
import {
  RunRegistry,
  RunRegistryDiagnosticsError,
} from "../../src/scenario/store/run-registry.js";
import { RunStore } from "../../src/scenario/store/run-store.js";
import type { RunManifest } from "../../src/scenario/store/types.js";
import {
  cleanupTemporaryTestRoots,
  createTemporaryTestRoot,
} from "../helpers/temporary-root.js";

const roots: string[] = [];

afterEach(async () => {
  await cleanupTemporaryTestRoots(roots);
});

async function fixture(): Promise<{ root: string; store: RunStore; manifest: RunManifest }> {
  const root = await createTemporaryTestRoot(roots, "run-store-");
  const manifest: RunManifest = {
    runId: "run-1",
    source: { kind: "scenarioFixture" },
    workingDir: null,
    projectDir: null,
    adapter: null,
    provider: null,
    nativeSessionIds: [],
    engineVersion: "test",
    schemaDigest: scenarioProtocolSchemaDigest(),
    capabilities: FULL_RUN_CAPABILITIES,
    storagePolicy: "durable",
    runtimeHome: { kind: "native", configuration: {} },
    configuration: {},
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    status: "created",
  };
  const store = new RunStore(root);
  await store.create(manifest, emptyScenarioSnapshot(manifest));
  return { root, store, manifest };
}

function failRunLockRelease(root: string, runId: string, failure: Error) {
  const realRm = fsModule.promises.rm.bind(fsModule.promises);
  const lockPath = path.join(canonicalRunDir(runId, root), ".write.lock");
  return vi.spyOn(fsModule.promises, "rm").mockImplementation(async (target, options) => {
    if (String(target) === lockPath) throw failure;
    return realRm(target, options);
  });
}

describe("RunStore", () => {
  it.each([
    "..",
    "../../victim",
    "run/child",
    "/absolute/run",
    "a".repeat(257),
  ])("rejects unsafe run ID %j before constructing a store path", async (runId) => {
    const root = await createTemporaryTestRoot(roots, "run-store-invalid-id-");

    expect(() => canonicalRunDir(runId, root)).toThrow(/path-safe protocol identifiers|Too big/);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("removes its exact temporary file when an atomic rename fails", async () => {
    const root = await createTemporaryTestRoot(roots, "atomic-json-failure-");
    const destination = path.join(root, "destination.json");
    await fs.mkdir(destination);

    await expect(writeJsonAtomically(destination, { value: true })).rejects.toBeDefined();
    expect(await fs.readdir(root)).toEqual(["destination.json"]);
  });

  it("uses the shared atomic cleanup path for artifact write failures", async () => {
    const root = await createTemporaryTestRoot(roots, "atomic-artifact-failure-");
    const bytes = Buffer.from("artifact");
    const hex = createHash("sha256").update(bytes).digest("hex");
    await fs.mkdir(path.join(root, hex), { recursive: true });

    await expect(new ArtifactStore(root).put({
      bytes,
      mediaType: "text/plain",
      visibility: "localSensitive",
    })).rejects.toBeDefined();
    expect(await fs.readdir(root)).toEqual([hex]);
  });

  it("propagates operational errors while checking whether a run exists", async () => {
    const root = await createTemporaryTestRoot(roots, "run-store-exists-error-");
    const manifestDir = path.join(root, "runs", "loop-run");
    await fs.mkdir(manifestDir, { recursive: true });
    await fs.symlink("manifest.json", path.join(manifestDir, "manifest.json"));

    await expect(new RunStore(root).exists("loop-run")).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("rejects a run-directory symlink without reading, locking, or mutating its target", async () => {
    const context = await fixture();
    const external = path.join(context.root, "external-valid-run");
    await fs.cp(context.store.runDir("run-1"), external, { recursive: true });
    const escapedRun = path.join(context.root, "runs", "escaped-run");
    await fs.symlink(external, escapedRun, "dir");
    const journalPath = path.join(external, "scenario.records.jsonl");
    const journalBefore = await fs.readFile(journalPath, "utf8").catch(() => "");
    const escapedStore = new RunStore(context.root);

    await expect(escapedStore.exists("escaped-run")).rejects.toThrow(
      "Canonical run path is not a genuine directory",
    );
    await expect(escapedStore.open("escaped-run")).rejects.toThrow(
      "Canonical run path is not a genuine directory",
    );
    await expect(escapedStore.transact("escaped-run", async () => ({
      records: [],
      value: null,
    }))).rejects.toThrow("Canonical run path is not a genuine directory");
    await expect(fs.access(path.join(external, ".write.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(journalPath, "utf8").catch(() => "")).resolves.toBe(journalBefore);
  });

  it("rejects a symlinked artifact directory without deleting from its target", async () => {
    const context = await fixture();
    const external = path.join(context.root, "external-artifacts");
    const victim = path.join(external, "victim.txt");
    await fs.mkdir(external);
    await fs.writeFile(victim, "preserve me", "utf8");
    const artifactsDir = runArtifactsDir("run-1", context.root);
    await fs.symlink(external, artifactsDir, "dir");

    await expect(context.store.open("run-1")).rejects.toThrow(
      "Artifact path is not a genuine directory",
    );
    expect(await fs.readFile(victim, "utf8")).toBe("preserve me");
    expect((await fs.lstat(artifactsDir)).isSymbolicLink()).toBe(true);
  });

  it("rejects an artifact symlink without reading or unlinking its external target", async () => {
    const context = await fixture();
    const external = path.join(context.root, "external-artifact.txt");
    await fs.writeFile(external, "external artifact bytes", "utf8");
    const artifactsDir = runArtifactsDir("run-1", context.root);
    await fs.mkdir(artifactsDir);
    const artifactLink = path.join(artifactsDir, "orphan-link");
    await fs.symlink(external, artifactLink);

    await expect(context.store.open("run-1")).rejects.toThrow(
      "Artifact path is not a regular file",
    );
    expect(await fs.readFile(external, "utf8")).toBe("external artifact bytes");
    expect((await fs.lstat(artifactLink)).isSymbolicLink()).toBe(true);
  });

  it("ignores and diagnoses a partial final journal line", async () => {
    const context = await fixture();
    await fs.writeFile(runJournalPath("run-1", context.root), "{\"partial\":", "utf8");
    const journal = await readScenarioJournal(runJournalPath("run-1", context.root));
    expect(journal.records).toEqual([]);
    expect(journal.diagnostics).toEqual(["Ignored a final partial journal line"]);
  });

  it("discards an interrupted command frame at every record boundary and retries the whole command", async () => {
    const interruptionPoints = [
      "inside-command-accepted",
      "after-command-accepted",
      "inside-semantic-record",
      "after-semantic-record",
    ] as const;
    for (const interruptionPoint of interruptionPoints) {
      const root = await createTemporaryTestRoot(roots, `run-store-framed-${interruptionPoint}-`);
      const runtime = createTestScenarioRuntime({ root });
      const runId = `framed-${interruptionPoint}`;
      await runtime.dispatch(testStartRunCommand({
        runId,
        commandId: "start",
        source: { kind: "scenarioFixture" },
        recordedAt: "2026-07-16T12:00:00.000Z",
        payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
      }));
      const command: ScenarioCommand = {
        runId,
        commandId: "interrupted-state-command",
        source: { kind: "scenarioFixture" },
        recordedAt: "2026-07-16T12:00:01.000Z",
        payload: {
          type: "stateSliceChanged",
          key: "interrupted.batch",
          schemaId: "test://interrupted-batch",
          status: "validated",
          source: "framed-journal-test",
          visibility: "localSensitive",
          value: { applied: true },
          diagnostics: [],
        },
      };
      await runtime.dispatch(command);
      const journalPath = runJournalPath(runId, root);
      const journalText = await fs.readFile(journalPath, "utf8");
      const frames = journalText.trimEnd().split("\n");
      const commandFrame = frames.at(-1)!;
      const batch = JSON.parse(commandFrame) as ScenarioRecord[];
      expect(batch).toHaveLength(2);
      const accepted = JSON.stringify(batch[0]);
      const semantic = JSON.stringify(batch[1]);
      const cutAt = {
        "inside-command-accepted": 1 + Math.floor(accepted.length / 2),
        "after-command-accepted": 1 + accepted.length,
        "inside-semantic-record": 1 + accepted.length + 1 + Math.floor(semantic.length / 2),
        "after-semantic-record": commandFrame.length - 1,
      }[interruptionPoint];
      const committedPrefix = `${frames.slice(0, -1).join("\n")}\n`;
      await fs.writeFile(journalPath, committedPrefix + commandFrame.slice(0, cutAt), "utf8");

      const recoveredRuntime = createTestScenarioRuntime({ root });
      const recovered = await recoveredRuntime.snapshot(runId);
      expect(recovered.commandResults[command.commandId]).toBeUndefined();
      expect(recovered.stateSlices["interrupted.batch"]).toBeUndefined();

      await expect(recoveredRuntime.dispatch(command)).resolves.toEqual({ status: "accepted" });
      const retried = await recoveredRuntime.snapshot(runId);
      expect(retried.stateSlices["interrupted.batch"]?.value).toEqual({ applied: true });
      expect((await readScenarioJournal(journalPath)).records.filter((record) =>
        record.commandId === command.commandId
      )).toHaveLength(2);
    }
  });

  it("treats empty JSONL stores as complete streams", async () => {
    const context = await fixture();
    const journalPath = runJournalPath("run-1", context.root);
    const feedbackPath = path.join(context.root, "empty-feedback.jsonl");
    await Promise.all([
      fs.writeFile(journalPath, "", "utf8"),
      fs.writeFile(feedbackPath, "", "utf8"),
    ]);

    await expect(readScenarioJournal(journalPath)).resolves.toEqual({
      records: [],
      diagnostics: [],
      validByteLength: 0,
    });
    await expect(readFeedbackStream(feedbackPath)).resolves.toEqual({
      entries: [],
      validByteLength: 0,
      hadPartialTail: false,
    });
  });

  it("recovers a snapshot cursor mismatch from the journal", async () => {
    const context = await fixture();
    await context.store.transact("run-1", async () => ({
      records: [{
        runId: "run-1",
        recordSeq: 1,
        recordId: "record-1",
        recordedAt: "2026-07-15T12:00:00.000Z",
        commandId: "command-1",
        eventType: "run.started",
        visibility: "public",
        payload: {},
      }],
      value: null,
    }));
    const snapshotPath = runSnapshotPath("run-1", context.root);
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    snapshot.lastRecordSeq = 0;
    await fs.writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");

    const openResult = await context.store.open("run-1");
    const opened = openResult.run;
    expect(openResult.committedBatches.map((batch) =>
      batch.records.map((record) => record.eventType)
    )).toEqual([
      ["recovery.completed"],
      ["store.diagnostic"],
    ]);
    expect(opened.snapshot.lastRecordSeq).toBe(3);
    expect(opened.snapshot.status).toBe("running");
    expect(opened.diagnostics.some((diagnostic) => diagnostic.includes("Recovered snapshot from canonical journal")))
      .toBe(true);
    expect(opened.records.at(-2)).toMatchObject({ eventType: "recovery.completed", recordSeq: 2 });
    expect(opened.records.at(-1)).toMatchObject({
      eventType: "store.diagnostic",
      recordSeq: 3,
      payload: { status: "recovered", source: "runStore" },
    });
    expect(opened.snapshot.stateSlices["store.health"]).toMatchObject({
      status: "recovered",
      source: "runStore",
    });
  });

  it("discards an inflated stored revision and derives batch revisions from the journal", async () => {
    const context = await fixture();
    await context.store.transact("run-1", async () => ({
      records: [{
        runId: "run-1",
        recordSeq: 1,
        recordId: "authoritative-record",
        recordedAt: "2026-07-15T12:00:00.000Z",
        commandId: "authoritative-command",
        eventType: "run.started",
        visibility: "public",
        payload: {},
      }],
      value: null,
    }));
    const snapshotPath = runSnapshotPath("run-1", context.root);
    const inflated = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    inflated.revision = 99;
    await fs.writeFile(snapshotPath, JSON.stringify(inflated), "utf8");

    const opened = (await context.store.open("run-1")).run;
    expect(opened.snapshot.revision).toBe(scenarioJournalRevision(opened.records));
    expect(opened.snapshot.revision).toBeLessThan(99);
    expect(opened.diagnostics).toContainEqual(expect.stringContaining(
      "Recovered snapshot from canonical journal after semantic or cursor mismatch",
    ));

    const batches = await createTestScenarioRuntime({ root: context.root }).committedBatchesAfter("run-1", 0);
    expect(batches.map((batch) => [batch.baseSnapshotRevision, batch.resultingSnapshotRevision]))
      .toEqual(batches.map((_batch, index) => [index, index + 1]));
    expect(batches.at(-1)?.resultingSnapshotRevision).toBe(scenarioJournalRevision(opened.records));
  });

  it("repairs a stale manifest after journal and snapshot commit before manifest failure", async () => {
    const context = await fixture();
    const manifestPath = runManifestPath("run-1", context.root);
    const staleManifest = await fs.readFile(manifestPath, "utf8");
    const recordedAt = "2026-07-15T12:05:00.000Z";

    await expect(context.store.transact("run-1", async (run) => {
      await fs.rm(manifestPath);
      await fs.mkdir(manifestPath);
      return {
        records: [
          {
            runId: "run-1",
            recordSeq: run.snapshot.lastRecordSeq + 1,
            recordId: "close-accepted",
            recordedAt,
            commandId: "close-command",
            eventType: "command.accepted" as const,
            visibility: "public" as const,
            payload: { result: { status: "accepted" } },
          },
          {
            runId: "run-1",
            recordSeq: run.snapshot.lastRecordSeq + 2,
            recordId: "close-record",
            recordedAt,
            commandId: "close-command",
            eventType: "run.closed" as const,
            visibility: "public" as const,
            payload: {},
          },
        ] as ScenarioRecord[],
        manifest: { ...run.manifest, status: "closed" as const, updatedAt: recordedAt },
        value: null,
      };
    })).rejects.toBeDefined();

    await fs.rm(manifestPath, { recursive: true });
    await fs.writeFile(manifestPath, staleManifest, "utf8");
    const recovered = (await context.store.open("run-1")).run;
    expect(recovered.manifest.status).toBe("closed");
    expect(Date.parse(recovered.manifest.updatedAt)).toBeGreaterThanOrEqual(Date.parse(recordedAt));
    expect(recovered.diagnostics).toContain("Recovered stale run manifest from the canonical journal");
    expect(JSON.parse(await fs.readFile(manifestPath, "utf8"))).toMatchObject({
      status: "closed",
      updatedAt: recovered.manifest.updatedAt,
    });
  });

  it("reconstructs registry discovery from manifests", async () => {
    const context = await fixture();
    const runs = await new RunRegistry(context.root).reconstruct();
    expect(runs.map((run) => run.runId)).toEqual([context.manifest.runId]);
  });

  it("preserves an index append failure when releasing its registry lock also fails", async () => {
    const context = await fixture();
    const index = runIndexPath(context.root);
    const releaseFailure = new Error("injected registry lock release failure");
    await fs.rm(index, { force: true });
    await fs.mkdir(index);
    const realRm = fsModule.promises.rm.bind(fsModule.promises);
    const registryLockPath = path.join(context.root, ".run-index", ".write.lock");
    const remove = vi.spyOn(fsModule.promises, "rm").mockImplementation(async (target, options) => {
      if (String(target) === registryLockPath) throw releaseFailure;
      return realRm(target, options);
    });

    try {
      await expect(new RunRegistry(context.root).append(context.manifest, "updated"))
        .rejects.toMatchObject({ code: "EISDIR" });
      expect(remove).toHaveBeenCalled();
    } finally {
      remove.mockRestore();
      await fs.rm(path.join(context.root, ".run-index", ".write.lock"), { recursive: true, force: true });
    }
  });

  it("does not create registry debris while reading or transacting on a missing run", async () => {
    const context = await fixture();

    await expect(context.store.open("missing-run")).rejects.toThrow("Run does not exist: missing-run");
    await expect(context.store.transact("missing-transaction", async () => ({
      records: [],
      value: null,
    }))).rejects.toThrow("Run does not exist: missing-transaction");

    expect((await fs.readdir(path.join(context.root, "runs"))).sort()).toEqual(["run-1"]);
    await expect(new RunRegistry(context.root).list()).resolves.toMatchObject([{ runId: "run-1" }]);
  });

  it("exposes malformed run directories and never reports a partial registry as successful", async () => {
    const context = await fixture();
    const malformedDir = path.join(context.root, "runs", "malformed-run");
    await fs.mkdir(malformedDir, { recursive: true });
    await fs.writeFile(path.join(malformedDir, "manifest.json"), "{not-json", "utf8");
    const registry = new RunRegistry(context.root);

    await expect(registry.inspect()).resolves.toMatchObject({
      manifests: [expect.objectContaining({ runId: "run-1" })],
      diagnostics: [{
        kind: "malformedManifest",
        runDirectory: malformedDir,
        manifestPath: path.join(malformedDir, "manifest.json"),
      }],
    });
    await expect(registry.list()).rejects.toBeInstanceOf(RunRegistryDiagnosticsError);
  });

  it("propagates operational manifest read failures", async () => {
    const context = await fixture();
    const brokenDir = path.join(context.root, "runs", "broken-run");
    await fs.mkdir(path.join(brokenDir, "manifest.json"), { recursive: true });

    await expect(new RunRegistry(context.root).inspect()).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("discovers every run source and resolves native session/transcript identifiers", async () => {
    const context = await fixture();
    for (const [runId, source, nativeSessionIds] of [
      ["hook-run", { kind: "hostHook" as const, adapter: "claude", nativeSessionId: "claude-native" }, ["/native/claude.jsonl"]],
      ["fixture-run", { kind: "scenarioFixture" as const }, []],
      ["provider-run", { kind: "providerSdk" as const, provider: "codex", nativeSessionId: "codex-native" }, ["/native/codex.jsonl"]],
    ] as const) {
      const manifest = {
        ...context.manifest,
        runId,
        source,
        nativeSessionIds: [...nativeSessionIds],
      };
      await context.store.create(manifest, emptyScenarioSnapshot(manifest));
    }
    const registry = new RunRegistry(context.root);
    expect((await registry.reconstruct()).map((run) => run.runId).sort()).toEqual([
      "fixture-run",
      "hook-run",
      "provider-run",
      "run-1",
    ]);
    expect((await registry.findByNativeIdentifier("claude-native"))?.runId).toBe("hook-run");
    expect((await registry.findByNativeIdentifier("/native/codex.jsonl"))?.runId).toBe("provider-run");
  });

  it("uses identical canonical journal and snapshot semantics for durable and ephemeral runs", async () => {
    const context = await fixture();
    const ephemeral = { ...context.manifest, runId: "ephemeral", storagePolicy: "ephemeral" as const };
    await context.store.create(ephemeral, emptyScenarioSnapshot(ephemeral));
    for (const runId of ["run-1", "ephemeral"]) {
      await context.store.transact(runId, async (run) => ({
        records: [{
          runId,
          recordSeq: run.snapshot.lastRecordSeq + 1,
          recordId: `${runId}-record`,
          recordedAt: "2026-07-15T12:00:00.000Z",
          commandId: `${runId}-command`,
          eventType: "run.started" as const,
          visibility: "public" as const,
          payload: {},
        }],
        manifest: {
          ...run.manifest,
          status: "running",
          updatedAt: "2026-07-15T12:00:00.000Z",
        },
        value: null,
      }));
      const opened = (await context.store.open(runId)).run;
      expect(opened.records).toHaveLength(1);
      expect(opened.snapshot.lastRecordSeq).toBe(1);
      await expect(fs.access(runJournalPath(runId, context.root))).resolves.toBeUndefined();
      await expect(fs.access(runSnapshotPath(runId, context.root))).resolves.toBeUndefined();
    }
  });

  it("preserves the authoritative revision for multi-command seeded journals", async () => {
    const context = await fixture();
    const records: ScenarioRecord[] = [1, 2].map((index) => ({
      runId: "run-1",
      recordSeq: index,
      recordId: `seed-record-${index}`,
      recordedAt: `2026-07-15T12:0${index}:00.000Z`,
      commandId: `seed-command-${index}`,
      eventType: "plan.stateChanged",
      visibility: "localSensitive",
      payload: { state: { step: index } },
    }));
    const targetRoot = await createTemporaryTestRoot(roots, "run-store-seeded-");
    const targetStore = new RunStore(targetRoot);

    const seeded = await targetStore.createSeeded(context.manifest, records);
    const opened = (await targetStore.open("run-1")).run;

    expect(seeded.revision).toBe(2);
    expect(opened.manifest.updatedAt).toBe(records.at(-1)?.recordedAt);
    expect(opened.diagnostics).toEqual([]);
    expect(opened.snapshot.revision).toBe(2);
    expect(opened.records).toEqual(records);
    expect(opened.records.some((record) => record.eventType === "recovery.completed")).toBe(false);
  });

  it("rejects a supplied seed snapshot that disagrees with its journal", async () => {
    const context = await fixture();
    const records: ScenarioRecord[] = [{
      runId: "run-1",
      recordSeq: 1,
      recordId: "seed-record",
      recordedAt: "2026-07-15T12:01:00.000Z",
      commandId: "seed-command",
      eventType: "plan.stateChanged",
      visibility: "localSensitive",
      payload: { state: { step: 1 } },
    }];
    const authoritative = reduceScenarioRecords(
      emptyScenarioSnapshot(context.manifest),
      records,
      scenarioJournalRevision(records),
    );
    const targetRoot = await createTemporaryTestRoot(roots, "run-store-seeded-mismatch-");

    await expect(new RunStore(targetRoot).createSeeded(
      context.manifest,
      records,
      { ...authoritative, revision: authoritative.revision + 1 },
    )).rejects.toThrow("Seed snapshot does not match the authoritative journal reduction");
  });

  it("rejects malformed timestamps before reducing a seeded journal", async () => {
    const context = await fixture();
    const targetRoot = await createTemporaryTestRoot(roots, "run-store-invalid-timestamp-");
    const malformed: ScenarioRecord = {
      runId: "run-1",
      recordSeq: 1,
      recordId: "invalid-timestamp-record",
      recordedAt: "not-a-timestamp",
      commandId: "invalid-timestamp-command",
      eventType: "plan.stateChanged",
      visibility: "localSensitive",
      payload: { state: {} },
    };

    await expect(new RunStore(targetRoot).createSeeded(context.manifest, [malformed])).rejects.toThrow();
    await expect(fs.access(path.join(targetRoot, "runs", "run-1"))).rejects.toThrow();
    await expect(new RunRegistry(targetRoot).list()).resolves.toEqual([]);
  });

  it("keeps the canonical run absent and registry healthy after staged persistence fails", async () => {
    const context = await fixture();
    const stagingRoot = path.join(context.root, ".run-staging");
    await fs.rm(stagingRoot, { recursive: true });
    await fs.writeFile(stagingRoot, "blocks staging directory creation", "utf8");
    const manifest = { ...context.manifest, runId: "persistence-failure" };

    await expect(context.store.create(manifest, emptyScenarioSnapshot(manifest))).rejects.toBeDefined();

    await expect(fs.access(path.join(context.root, "runs", manifest.runId))).rejects.toThrow();
    await expect(new RunRegistry(context.root).list()).resolves.toMatchObject([{ runId: "run-1" }]);
  });

  it("releases the creation lock and preserves the persistence error when staging cleanup fails", async () => {
    const context = await fixture();
    const manifest = { ...context.manifest, runId: "cleanup-failure" };
    const primaryFailure = new Error("injected publish failure");
    const cleanupFailure = new Error("injected staging cleanup failure");
    const realRename = fsModule.promises.rename.bind(fsModule.promises);
    const realRm = fsModule.promises.rm.bind(fsModule.promises);
    const destination = path.join(context.root, "runs", manifest.runId);
    const stagingRoot = path.join(context.root, ".run-staging");
    const rename = vi.spyOn(fsModule.promises, "rename").mockImplementation(async (source, target) => {
      if (String(target) === destination && path.dirname(String(source)) === stagingRoot) throw primaryFailure;
      return realRename(source, target);
    });
    const remove = vi.spyOn(fsModule.promises, "rm").mockImplementation(async (target, options) => {
      const targetPath = String(target);
      if (path.dirname(targetPath) === stagingRoot && path.basename(targetPath).startsWith(`${manifest.runId}-`)) {
        throw cleanupFailure;
      }
      return realRm(target, options);
    });

    try {
      await expect(context.store.create(manifest, emptyScenarioSnapshot(manifest))).rejects.toBe(primaryFailure);
      await expect(fs.access(path.join(context.root, ".run-creation", ".write.lock"))).rejects.toThrow();
    } finally {
      rename.mockRestore();
      remove.mockRestore();
    }

    await expect(context.store.create(manifest, emptyScenarioSnapshot(manifest))).resolves.toBeUndefined();
    await expect(context.store.exists(manifest.runId)).resolves.toBe(true);
  });

  it("preserves an open failure when releasing its run lock also fails", async () => {
    const context = await fixture();
    const releaseFailure = new Error("injected open lock release failure");
    await fs.writeFile(runManifestPath("run-1", context.root), "{malformed", "utf8");
    const remove = failRunLockRelease(context.root, "run-1", releaseFailure);

    try {
      await expect(context.store.open("run-1")).rejects.toBeInstanceOf(SyntaxError);
      expect(remove).toHaveBeenCalled();
    } finally {
      remove.mockRestore();
      await fs.rm(path.join(context.store.runDir("run-1"), ".write.lock"), { recursive: true, force: true });
    }
  });

  it("preserves a transaction failure when releasing its run lock also fails", async () => {
    const context = await fixture();
    const operationFailure = new Error("injected transaction failure");
    const releaseFailure = new Error("injected transaction lock release failure");
    const remove = failRunLockRelease(context.root, "run-1", releaseFailure);

    try {
      await expect(context.store.transact("run-1", async () => {
        throw operationFailure;
      })).rejects.toBe(operationFailure);
      expect(remove).toHaveBeenCalled();
    } finally {
      remove.mockRestore();
      await fs.rm(path.join(context.store.runDir("run-1"), ".write.lock"), { recursive: true, force: true });
    }
  });

  it("never exposes staged creation as a malformed registry entry", async () => {
    const context = await fixture();
    const targetRoot = await createTemporaryTestRoot(roots, "run-store-atomic-create-");
    const store = new RunStore(targetRoot);
    const registry = new RunRegistry(targetRoot);
    const manifest = { ...context.manifest, runId: "atomic-create" };
    const records: ScenarioRecord[] = Array.from({ length: 1_000 }, (_, index) => ({
      runId: manifest.runId,
      recordSeq: index + 1,
      recordId: `atomic-record-${index + 1}`,
      recordedAt: `2026-07-15T12:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      commandId: `atomic-command-${index + 1}`,
      eventType: "plan.stateChanged",
      visibility: "localSensitive",
      payload: { state: { index } },
    }));
    let creating = true;
    const creation = store.createSeeded(manifest, records).finally(() => { creating = false; });
    const observed: string[][] = [];

    do {
      observed.push((await registry.list()).map((candidate) => candidate.runId));
    } while (creating);
    await creation;
    observed.push((await registry.list()).map((candidate) => candidate.runId));

    expect(observed.length).toBeGreaterThan(1);
    expect(observed.every((runIds) =>
      runIds.length === 0 || (runIds.length === 1 && runIds[0] === manifest.runId)
    )).toBe(true);
  });

  it("reports one explicit collision for concurrent creators of the same run", async () => {
    const context = await fixture();
    const targetRoot = await createTemporaryTestRoot(roots, "run-store-create-collision-");
    const store = new RunStore(targetRoot);
    const creation = () => store.create(context.manifest, emptyScenarioSnapshot(context.manifest));

    const results = await Promise.allSettled([creation(), creation()]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([{
      reason: expect.objectContaining({ message: "Run already exists: run-1" }),
    }]);
    await expect(new RunRegistry(targetRoot).list()).resolves.toMatchObject([{ runId: "run-1" }]);
  });

  it("serializes concurrent writers without duplicate or missing record sequences", async () => {
    const context = await fixture();
    await Promise.all(Array.from({ length: 24 }, (_, index) => context.store.transact("run-1", async (run) => ({
      records: [{
        runId: "run-1",
        recordSeq: run.snapshot.lastRecordSeq + 1,
        recordId: `record-${index}`,
        recordedAt: "2026-07-15T12:00:00.000Z",
        commandId: `command-${index}`,
        eventType: "runtime.error",
        visibility: "localSensitive" as const,
        payload: { index, message: `concurrency probe ${index}`, recoverable: true },
      }],
      value: null,
    }))));

    const opened = (await context.store.open("run-1")).run;
    expect(opened.records.map((record) => record.recordSeq)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect(new Set(opened.records.map((record) => record.recordId)).size).toBe(24);
  });

  it("never evicts an old lock while its recorded owner is alive", async () => {
    const root = await createTemporaryTestRoot(roots, "run-lock-live-owner-");
    const lock = await acquireRunLock(root, { staleAfterMs: 1, timeoutMs: 100, retryMs: 1 });
    try {
      await expect(acquireRunLock(root, { staleAfterMs: 1, timeoutMs: 20, retryMs: 1 }))
        .rejects.toThrow("Timed out acquiring run transaction lock");
    } finally {
      await lock.release();
    }
  });

  it("recovers a stale lock when its PID belongs to a different process identity", async () => {
    const root = await createTemporaryTestRoot(roots, "run-lock-reused-pid-");
    const lockDir = path.join(root, ".write.lock");
    await fs.mkdir(lockDir);
    const ownerPath = path.join(lockDir, "owner.json");
    await fs.writeFile(ownerPath, JSON.stringify({
      pid: process.pid,
      processIdentity: "forged-process-identity",
      lockId: "reused-pid-lock",
      acquiredAt: new Date(0).toISOString(),
    }), "utf8");
    await fs.utimes(ownerPath, new Date(0), new Date(0));

    const lock = await acquireRunLock(root, { staleAfterMs: 1, timeoutMs: 100, retryMs: 1 });
    expect(lock.diagnostics).toEqual(["Recovered a stale run transaction lock"]);
    await lock.release();
  });

  it("recovers an ownerless lock directory only after its stale threshold", async () => {
    const root = await createTemporaryTestRoot(roots, "run-lock-ownerless-");
    const lockDir = path.join(root, ".write.lock");
    await fs.mkdir(lockDir);
    await fs.utimes(lockDir, new Date(0), new Date(0));

    const lock = await acquireRunLock(root, { staleAfterMs: 1, timeoutMs: 100, retryMs: 1 });
    expect(lock.diagnostics).toEqual(["Recovered a stale run transaction lock"]);
    await lock.release();
  });

  it("persists heartbeat failures discovered while a transaction owns the lock", async () => {
    const context = await fixture();
    const store = new RunStore(context.root, { staleAfterMs: 30, timeoutMs: 100, retryMs: 1 });
    const result = await store.transact("run-1", async () => {
      const ownerPath = path.join(store.runDir("run-1"), ".write.lock", "owner.json");
      const owner = await fs.readFile(ownerPath, "utf8");
      await fs.rm(ownerPath);
      await fs.mkdir(ownerPath);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      await fs.rm(ownerPath, { recursive: true });
      await fs.writeFile(ownerPath, owner, "utf8");
      return { records: [], value: null };
    });

    expect(result.diagnostics).toContainEqual(expect.stringContaining("Run lock heartbeat failed"));
    expect(result.committedBatches).toHaveLength(1);
    expect(result.committedBatches[0]).toMatchObject({
      baseSnapshotRevision: result.snapshot.revision - 1,
      resultingSnapshotRevision: result.snapshot.revision,
      records: [
        {
          eventType: "store.diagnostic",
          payload: {
            message: expect.stringContaining("Run lock heartbeat failed"),
            source: "runLock",
            status: "recovered",
          },
        },
      ],
      snapshot: { revision: result.snapshot.revision },
    });
    expect((await store.open("run-1")).run.records.some((record) =>
      record.eventType === "store.diagnostic" &&
      typeof record.payload.message === "string" &&
      record.payload.message.includes("Run lock heartbeat failed")
    )).toBe(true);
  });

  it("recovers corrupt snapshots and stale lock directories visibly", async () => {
    const context = await fixture();
    await fs.writeFile(runSnapshotPath("run-1", context.root), "{not-json", "utf8");
    const lockDir = path.join(context.store.runDir("run-1"), ".write.lock");
    await fs.mkdir(lockDir);
    const ownerPath = path.join(lockDir, "owner.json");
    await fs.writeFile(ownerPath, JSON.stringify({
      pid: 999_999_999,
      lockId: "abandoned-lock",
      acquiredAt: new Date(0).toISOString(),
    }), "utf8");
    await fs.utimes(ownerPath, new Date(0), new Date(0));

    const opened = (await new RunStore(context.root, {
      staleAfterMs: 1,
      timeoutMs: 100,
      retryMs: 1,
    }).open("run-1")).run;
    expect(opened.diagnostics).toContain("Recovered a stale run transaction lock");
    expect(opened.diagnostics.some((diagnostic) => diagnostic.includes("Recovered a corrupt snapshot"))).toBe(true);
    expect(opened.records.some((record) => record.eventType === "recovery.completed")).toBe(true);
    expect(opened.records.at(-1)).toMatchObject({
      eventType: "store.diagnostic",
      payload: { source: "runLock", status: "recovered" },
    });
    expect(opened.snapshot.stateSlices["store.health"]).toMatchObject({
      status: "recovered",
      source: "runLock",
    });
  });

});
