import type { ScenarioCommand } from "../../src/scenario/protocol/commands.js";
import { FULL_RUN_CAPABILITIES } from "../../src/scenario/protocol/capabilities.js";
import { scenarioProtocolSchemaDigest } from "../../src/scenario/protocol/schema.js";
import { createScenarioCommandEnvelope } from "../../src/scenario/protocol/command-envelope.js";
import { PROVIDER_TYPES, type ResolvedProvider } from "../../src/utils/provider-config.js";

type StartRunPayload = Extract<ScenarioCommand["payload"], { type: "startRun" }>;
type StartRunCommand = Omit<ScenarioCommand, "payload"> & { payload: StartRunPayload };
type ScenarioCommandEnvelopeOverrides = Partial<
  Omit<ScenarioCommand, "runId" | "commandId" | "payload">
>;
type TestStartRunCommandOverrides = Omit<Partial<ScenarioCommand>, "payload"> & {
  payload?: Partial<StartRunPayload>;
};

export function testScenarioCommand(
  runId: string,
  commandId: string,
  payload: ScenarioCommand["payload"],
  overrides: ScenarioCommandEnvelopeOverrides | string = {},
): ScenarioCommand {
  const envelope = typeof overrides === "string" ? { recordedAt: overrides } : overrides;
  return createScenarioCommandEnvelope({
    runId,
    commandId,
    source: envelope.source ?? { kind: "scenarioFixture", adapter: "direct" },
    recordedAt: envelope.recordedAt ?? "2026-07-15T12:00:00.000Z",
    ...(envelope.expectedSnapshotRevision === undefined
      ? {}
      : { expectedSnapshotRevision: envelope.expectedSnapshotRevision }),
    ...(envelope.correlationId === undefined ? {} : { correlationId: envelope.correlationId }),
    ...(envelope.causationId === undefined ? {} : { causationId: envelope.causationId }),
    payload,
  });
}

export function testScenarioCommandFactory(
  runId: string,
  source: ScenarioCommand["source"],
  recordedAt = "2026-07-15T12:00:00.000Z",
): (commandId: string, payload: ScenarioCommand["payload"]) => ScenarioCommand {
  return (commandId, payload) => testScenarioCommand(
    runId,
    commandId,
    payload,
    { source, recordedAt },
  );
}

export function testResolvedProvider(
  overrides: Partial<ResolvedProvider> = {},
): ResolvedProvider {
  return {
    type: PROVIDER_TYPES.OPENROUTER,
    mode: "sdk",
    modelId: "test-model",
    sdkRuntime: "claude",
    costTracking: "none",
    ...overrides,
  } satisfies ResolvedProvider;
}

export function testStartRunCommand(
  overrides: TestStartRunCommandOverrides = {},
): StartRunCommand {
  const {
    payload: payloadOverrides = {},
    runId = "test-run",
    commandId = "start",
    source = { kind: "scenarioFixture" },
    recordedAt = "2026-07-15T12:00:00.000Z",
    ...envelope
  } = overrides;
  const payload: StartRunPayload = {
    type: "startRun",
    workingDir: "/workspace",
    projectDir: "/workspace",
    capabilities: FULL_RUN_CAPABILITIES,
    storagePolicy: "durable",
    runtimeHome: { kind: "native", configuration: {} },
    engineVersion: "test",
    schemaDigest: scenarioProtocolSchemaDigest(),
    configuration: {},
    ...payloadOverrides,
  };
  return testScenarioCommand(runId, commandId, payload, {
    source,
    recordedAt,
    ...envelope,
  }) as StartRunCommand;
}

export function createTestStartRunCommandBuilder(
  defaults: Omit<TestStartRunCommandOverrides, "runId" | "commandId"> & {
    commandId?: string | ((runId: string) => string);
  } = {},
): (runId: string, overrides?: Omit<TestStartRunCommandOverrides, "runId">) => StartRunCommand {
  const { commandId: defaultCommandId, payload: defaultPayload, ...defaultEnvelope } = defaults;
  return (runId, overrides = {}) => {
    const { payload, ...envelope } = overrides;
    const commandId = envelope.commandId ?? (
      typeof defaultCommandId === "function" ? defaultCommandId(runId) : defaultCommandId
    );
    return testStartRunCommand({
      ...defaultEnvelope,
      ...envelope,
      runId,
      ...(commandId === undefined ? {} : { commandId }),
      payload: { ...defaultPayload, ...payload },
    });
  };
}
