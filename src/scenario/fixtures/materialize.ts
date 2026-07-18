import type { ArtifactRef } from "../protocol/artifacts.js";
import {
  isScenarioEffectLifecycleCommand,
  scenarioCommandSchema,
  type ScenarioCommand,
} from "../protocol/commands.js";
import type { JsonValue } from "../protocol/common.js";
import { assertScenarioCommandDigests } from "../protocol/digest.js";
import { canonicalJson, canonicalJsonEqual } from "../protocol/canonical-json.js";
import type { ScenarioRecord } from "../protocol/records.js";
import type { ScenarioRuntime } from "../runtime/runtime.js";
import { hydrateArtifactValues, trustedArtifactValueReferences } from "../runtime/artifact-values.js";
import type { FixtureEffectOutcome, FixtureExpectation, ScenarioFixture } from "./types.js";
import { validateScenarioFixture } from "./validator.js";
import { sanitizeScenarioName } from "../name.js";
import type { ScenarioFixturePolicy } from "./policy.js";

export type MaterializeFixtureOptions = {
  name?: string;
  description?: string;
  policy?: ScenarioFixturePolicy;
};

/** Materialize a replayable fixture by slicing one canonical run journal. */
export async function materializeScenarioFixture(
  runtime: ScenarioRuntime,
  runId: string,
  options: MaterializeFixtureOptions = {},
): Promise<ScenarioFixture> {
  const { records, snapshot } = await runtime.canonicalView(runId);
  const artifacts = new Map(snapshot.artifacts.map((artifact) => [artifact.digest, artifact]));
  const trustedReferences = trustedArtifactValueReferences(records);
  const accepted = await Promise.all(records
    .filter((record) => record.eventType === "command.accepted")
    .map((record) => commandFromAcceptedRecord(runtime, runId, record, artifacts, trustedReferences)));
  const capturedStartCommand = accepted.find((command) => command.payload.type === "startRun");
  if (!capturedStartCommand) throw new Error(`Run ${runId} has no canonical startRun command`);
  const startCommand = scenarioCommandSchema.parse({
    ...capturedStartCommand,
    source: {
      kind: "scenarioFixture",
      ...(capturedStartCommand.source.adapter === undefined
        ? {}
        : { adapter: capturedStartCommand.source.adapter }),
    },
  });

  const effectOutcomes: Record<string, FixtureEffectOutcome> = {};
  for (const command of accepted) {
    if (command.causationId === undefined) continue;
    if (command.payload.type === "effectResultSupplied") {
      effectOutcomes[command.payload.effectId] = {
        outcome: "completed",
        result: command.payload.result ?? null,
        ...(command.payload.metadata === undefined ? {} : { metadata: command.payload.metadata }),
      };
    } else if (command.payload.type === "effectFailed") {
      effectOutcomes[command.payload.effectId] = { outcome: "failed", error: command.payload.error };
    } else if (command.payload.type === "effectCancelled") {
      effectOutcomes[command.payload.effectId] = { outcome: "cancelled", reason: command.payload.reason };
    }
  }

  const commands = accepted.filter((command) => {
    if (command.commandId === capturedStartCommand.commandId) return false;
    if (isScenarioEffectLifecycleCommand(command.payload)) {
      return command.causationId === undefined;
    }
    if (command.payload.type === "submitFeedback") return false;
    return true;
  });
  const liveBehavior = options.policy?.isLiveBehavior?.({ commands, snapshot }) === true;
  const semanticRecords = records.filter((record) =>
    record.eventType !== "command.accepted" &&
    record.eventType !== "artifact.linked" &&
    record.eventType !== "feedback.changed" &&
    record.eventType !== "recovery.completed" &&
    record.eventType !== "effect.progressed" &&
    record.eventType !== "store.diagnostic" &&
    record.eventType !== "effect.claimRenewed"
  );
  const artifactCache = new Map<string, JsonValue>();
  const hydratedSemanticRecords = await Promise.all(semanticRecords.map(async (record) => ({
    record,
    payload: replayableExpectationPayload(
      record,
      await hydrateRecordPayload(runtime, runId, record, artifacts, artifactCache, trustedReferences),
    ),
  })));
  const expectations: FixtureExpectation[] = liveBehavior
    ? requireLiveExpectationProjector(options.policy)({
        records: hydratedSemanticRecords,
        snapshot,
        commands,
      })
    : hydratedSemanticRecords.map(({ record, payload }) => ({
        kind: "record",
        eventType: record.eventType,
        ...(record.entityRef === undefined
          ? {}
          : { entityKind: record.entityRef.kind, entityId: record.entityRef.id }),
        payloadContains: payload,
        count: countEquivalentRecords(hydratedSemanticRecords, record, payload),
      }));
  const deduplicatedExpectations = deduplicateExpectations(expectations);
  deduplicatedExpectations.push({ kind: "snapshot", path: "status", equals: snapshot.status });

  return validateScenarioFixture({
    name: options.name ?? `run-${sanitizeScenarioName(runId)}`,
    ...(options.description === undefined ? {} : { description: options.description }),
    initialRun: {
      startCommand,
      seedRecords: [],
    },
    commands,
    effects: liveBehavior
      ? { mode: "live" }
      : { mode: "deterministic", outcomes: effectOutcomes, rejectUnexpected: true },
    expectations: deduplicatedExpectations,
  });
}

function requireLiveExpectationProjector(
  policy: ScenarioFixturePolicy | undefined,
): NonNullable<ScenarioFixturePolicy["projectLiveExpectations"]> {
  if (!policy?.projectLiveExpectations) {
    throw new Error("Live fixture classification requires a live expectation projector");
  }
  return policy.projectLiveExpectations;
}

function replayableExpectationPayload(
  record: ScenarioRecord,
  payload: Record<string, JsonValue>,
): Record<string, JsonValue> {
  if (record.eventType === "state.sliceChanged" && payload.slice &&
    typeof payload.slice === "object" && !Array.isArray(payload.slice)) {
    const { updatedAt: _updatedAt, ...stableSlice } = payload.slice;
    return { ...payload, slice: stableSlice };
  }
  if (!["effect.started", "effect.completed", "effect.failed", "effect.cancelled"].includes(record.eventType)) return payload;
  const { claimId: _claimId, previousClaimId: _previousClaimId, ...stable } = payload;
  return stable;
}

async function commandFromAcceptedRecord(
  runtime: ScenarioRuntime,
  runId: string,
  record: ScenarioRecord,
  artifacts: ReadonlyMap<string, ArtifactRef>,
  trustedReferences: ReadonlySet<string>,
): Promise<ScenarioCommand> {
  const command = record.payload.command;
  if (command === undefined) {
    throw new Error(`Record ${record.recordSeq} predates canonical command capture`);
  }
  const hydrated = await hydrateArtifactValues(runtime, runId, command, artifacts, new Map(), trustedReferences);
  const parsed = scenarioCommandSchema.parse(hydrated);
  assertScenarioCommandDigests(parsed, " after artifact hydration");
  const { expectedSnapshotRevision: _expectedSnapshotRevision, ...replayCommand } = parsed;
  return scenarioCommandSchema.parse(replayCommand);
}

async function hydrateRecordPayload(
  runtime: ScenarioRuntime,
  runId: string,
  record: ScenarioRecord,
  artifacts: ReadonlyMap<string, ArtifactRef>,
  cache: Map<string, JsonValue>,
  trustedReferences: ReadonlySet<string>,
): Promise<Record<string, JsonValue>> {
  const hydrated = await hydrateArtifactValues(runtime, runId, record.payload, artifacts, cache, trustedReferences);
  if (typeof hydrated !== "object" || hydrated === null || Array.isArray(hydrated)) {
    throw new Error(`Record ${record.recordSeq} payload did not hydrate to an object`);
  }
  return hydrated;
}

function countEquivalentRecords(
  records: ReadonlyArray<{ record: ScenarioRecord; payload: Record<string, JsonValue> }>,
  target: ScenarioRecord,
  targetPayload: Record<string, JsonValue>,
): number {
  return records.filter(({ record, payload }) =>
    record.eventType === target.eventType &&
    record.entityRef?.kind === target.entityRef?.kind &&
    record.entityRef?.id === target.entityRef?.id &&
    canonicalJsonEqual(payload, targetPayload)
  ).length;
}

function deduplicateExpectations(expectations: readonly FixtureExpectation[]): FixtureExpectation[] {
  const seen = new Set<string>();
  return expectations.filter((expectation) => {
    const key = canonicalJson(expectation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
