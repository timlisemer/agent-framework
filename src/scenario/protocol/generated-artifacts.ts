import { FULL_RUN_CAPABILITIES } from "./capabilities.js";
import {
  MAXIMUM_ARTIFACT_BYTES,
  MAXIMUM_CLIENT_FRAME_BYTES,
} from "./limits.js";
import {
  buildScenarioProtocolManifest,
  buildScenarioProtocolSchemaBundle,
  scenarioProtocolSchemaDigest,
} from "./schema.js";

export const SCENARIO_PROTOCOL_ARTIFACT_NAMES = [
  "golden-frames.jsonl",
  "protocol-manifest.json",
  "schema-bundle.json",
  "schema-digest.txt",
] as const;
export type ScenarioProtocolArtifactName = typeof SCENARIO_PROTOCOL_ARTIFACT_NAMES[number];

/** Build the complete public contract export without relying on source-tree files. */
export function buildScenarioProtocolArtifacts(): ReadonlyMap<ScenarioProtocolArtifactName, string> {
  const bundle = buildScenarioProtocolSchemaBundle();
  const digest = scenarioProtocolSchemaDigest(bundle);
  const manifest = { ...buildScenarioProtocolManifest(), schemaDigest: digest };
  const goldenFrames = [
    {
      type: "hello",
      client: { name: "contract-test", version: "1.0.0" },
      capabilities: ["run.list", "run.read", "feedback.write"],
      schemaDigests: [digest],
    },
    {
      type: "welcome",
      subjectId: "contract-user",
      engineVersion: "1.0.0",
      schemaDigest: digest,
      capabilities: ["run.list", "run.read", "run.control", "tool.decide", "feedback.write", "artifact.read"],
      maximumFrameBytes: MAXIMUM_CLIENT_FRAME_BYTES,
      maximumArtifactBytes: MAXIMUM_ARTIFACT_BYTES,
      visibilityScope: ["public", "localSensitive", "artifactReference"],
      extensionSchemas: [],
    },
    {
      type: "request",
      requestId: "request-1",
      payload: { operation: "listRuns" },
    },
    {
      commandId: "command-1",
      runId: "run-1",
      source: { kind: "scenarioFixture", adapter: "direct" },
      recordedAt: "2026-07-15T12:00:00.000Z",
      payload: {
        type: "startRun",
        workingDir: "/workspace",
        projectDir: "/workspace",
        capabilities: FULL_RUN_CAPABILITIES,
        storagePolicy: "durable",
        runtimeHome: { kind: "managed", configuration: { profile: "default" } },
        engineVersion: "1.0.0",
        schemaDigest: digest,
        configuration: { fallbackPolicy: "deny" },
      },
    },
  ];

  const contents = [
    `${goldenFrames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
    `${JSON.stringify(manifest, null, 2)}\n`,
    `${JSON.stringify(bundle, null, 2)}\n`,
    `${digest}\n`,
  ] as const;
  return new Map(SCENARIO_PROTOCOL_ARTIFACT_NAMES.map((name, index) => [name, contents[index]!]));
}
