import { randomUUID } from "node:crypto";
import type { ScenarioCommand, ScenarioCommandPayload } from "./commands.js";
import type { RunSource } from "./common.js";

export type ScenarioCommandEnvelopeInput = {
  runId: string;
  source: RunSource;
  payload: ScenarioCommandPayload;
  commandId?: string;
  recordedAt?: string;
  expectedSnapshotRevision?: number;
  correlationId?: string;
  causationId?: string;
};

export type ScenarioCommandEnvelopeProviders = {
  idFactory: () => string;
  clock: () => Date;
};

const defaultProviders: ScenarioCommandEnvelopeProviders = {
  idFactory: randomUUID,
  clock: () => new Date(),
};

/** Construct the canonical command envelope shared by every Scenario boundary. */
export function createScenarioCommandEnvelope(
  input: ScenarioCommandEnvelopeInput,
  providers: Partial<ScenarioCommandEnvelopeProviders> = {},
): ScenarioCommand {
  const idFactory = providers.idFactory ?? defaultProviders.idFactory;
  const clock = providers.clock ?? defaultProviders.clock;
  return {
    commandId: input.commandId ?? idFactory(),
    runId: input.runId,
    source: input.source,
    recordedAt: input.recordedAt ?? clock().toISOString(),
    ...(input.expectedSnapshotRevision === undefined
      ? {}
      : { expectedSnapshotRevision: input.expectedSnapshotRevision }),
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    payload: input.payload,
  };
}
