import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactRef } from "../../src/scenario/protocol/artifacts.js";
import { scenarioProtocolSchemaDigest } from "../../src/scenario/protocol/schema.js";
import { redactScenarioValue } from "../../src/scenario/runtime/redaction.js";
import { createTestScenarioRuntime } from "../helpers/scenario-runtime.js";
import { testStartRunCommand } from "../helpers/scenario-fixtures.js";
import {
  runArtifactsDir,
  runJournalPath,
  runManifestPath,
} from "../../src/scenario/store/paths.js";
import {
  cleanupTemporaryTestRoots,
  createTemporaryTestRoot,
} from "../helpers/temporary-root.js";

const roots: string[] = [];
afterEach(async () => cleanupTemporaryTestRoots(roots));

describe("Scenario durable redaction", () => {
  it("redacts nested token, private-key, credential, and configured-path values", () => {
    const redacted = redactScenarioValue({
      nested: {
        token: "token-secret",
        private_key: "private-secret",
        credential: "credential-secret",
        accessToken: "access-token-secret",
        refreshToken: "refresh-token-secret",
        authToken: "auth-token-secret",
        bearerToken: "bearer-token-secret",
        clientSecret: "client-secret",
        custom: { passwordMaterial: "configured-secret" },
      },
    }, undefined, [], { secretPaths: ["nested.custom.passwordMaterial"] });
    const serialized = JSON.stringify(redacted);
    for (const secret of [
      "token-secret",
      "private-secret",
      "credential-secret",
      "access-token-secret",
      "refresh-token-secret",
      "auth-token-secret",
      "bearer-token-secret",
      "client-secret",
      "configured-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("never writes original credential values to the journal or extracted artifacts", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-redaction-");
    const runtime = createTestScenarioRuntime({ root, maximumInlineBytes: 8 });
    const base = { runId: "redaction-run", source: { kind: "scenarioFixture" as const }, recordedAt: "2026-07-16T12:00:00.000Z" };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "start",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    await runtime.dispatch({ ...base, commandId: "secret", payload: {
      type: "stateSliceChanged", key: "secret.test", schemaId: "test", status: "validated",
      source: "test", visibility: "localSensitive",
      value: {
        token: "journal-token-secret",
        private_key: "journal-private-secret",
        credential: "journal-credential-secret",
        accessToken: "journal-access-token-secret",
        refreshToken: "journal-refresh-token-secret",
        authToken: "journal-auth-token-secret",
        bearerToken: "journal-bearer-token-secret",
        clientSecret: "journal-client-secret",
      },
      diagnostics: [],
    } });
    const journal = await fs.readFile(runJournalPath(base.runId, root), "utf8");
    expect(journal).not.toContain("journal-token-secret");
    expect(journal).not.toContain("journal-private-secret");
    expect(journal).not.toContain("journal-credential-secret");
    expect(journal).not.toContain("journal-access-token-secret");
    expect(journal).not.toContain("journal-refresh-token-secret");
    expect(journal).not.toContain("journal-auth-token-secret");
    expect(journal).not.toContain("journal-bearer-token-secret");
    expect(journal).not.toContain("journal-client-secret");
    const artifactFiles = await fs.readdir(runArtifactsDir(base.runId, root)).catch(() => []);
    const artifactContents = (await Promise.all(artifactFiles.map((file) =>
      fs.readFile(path.join(runArtifactsDir(base.runId, root), file), "utf8")
    ))).join("\n");
    expect(artifactContents).not.toContain("journal-token-secret");
    expect(artifactContents).not.toContain("journal-private-secret");
    expect(artifactContents).not.toContain("journal-credential-secret");
    expect(artifactContents).not.toContain("journal-access-token-secret");
    expect(artifactContents).not.toContain("journal-refresh-token-secret");
    expect(artifactContents).not.toContain("journal-auth-token-secret");
    expect(artifactContents).not.toContain("journal-bearer-token-secret");
    expect(artifactContents).not.toContain("journal-client-secret");
  });

  it("redacts runtime-home credentials and configured private paths in durable metadata", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-runtime-home-redaction-");
    const runtime = createTestScenarioRuntime({
      root,
      redactionPaths: ["runtimeHome.configuration.privateCachePath"],
    });
    const runId = "runtime-home-redaction-run";
    const token = "runtime-home-token-secret";
    const privatePath = "/private/runtime-home/cache";
    await runtime.dispatch(testStartRunCommand({
      runId,
      commandId: "runtime-home-redaction-start",
      source: { kind: "scenarioFixture" },
      recordedAt: "2026-07-16T12:00:00.000Z",
      payload: {
        workingDir: null,
        projectDir: null,
        schemaDigest: scenarioProtocolSchemaDigest(),
        runtimeHome: {
          kind: "consumerOwned",
          configuration: { apiToken: token, privateCachePath: privatePath, harmless: "retained" },
        },
      },
    }));

    const durableManifest = await fs.readFile(runManifestPath(runId, root), "utf8");
    const snapshot = JSON.stringify(await runtime.snapshot(runId));
    for (const secret of [token, privatePath]) {
      expect(durableManifest).not.toContain(secret);
      expect(snapshot).not.toContain(secret);
    }
    expect(JSON.parse(durableManifest)).toMatchObject({
      runtimeHome: {
        kind: "consumerOwned",
        configuration: {
          apiToken: { redacted: true },
          privateCachePath: { redacted: true },
          harmless: "retained",
        },
      },
    });
  });

  it("redacts credentials embedded in ordinary command strings before journal or artifact persistence", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-command-string-redaction-");
    const runtime = createTestScenarioRuntime({ root, maximumInlineBytes: 8 });
    const runId = "command-string-redaction-run";
    await runtime.dispatch(testStartRunCommand({
      runId,
      commandId: "start",
      source: { kind: "scenarioFixture" },
      recordedAt: "2026-07-16T12:00:00.000Z",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    const secrets = [
      "sk-secret-value-123456",
      "environment-secret-value",
      "url-password-value",
      "ghp_123456789012345678901234567890",
    ];
    const command = [
      `curl -H 'x-api-key: ${secrets[0]}'`,
      `API_TOKEN=${secrets[1]}`,
      `https://user:${secrets[2]}@example.test/resource`,
      secrets[3],
    ].join(" ");
    await runtime.dispatch({
      runId,
      commandId: "embedded-command-secrets",
      source: { kind: "scenarioFixture" },
      recordedAt: "2026-07-16T12:00:01.000Z",
      payload: {
        type: "stateSliceChanged",
        key: "command.capture",
        schemaId: "test://command-capture",
        status: "validated",
        source: "test",
        visibility: "localSensitive",
        value: { command },
        diagnostics: [],
      },
    });

    const journal = await fs.readFile(runJournalPath(runId, root), "utf8");
    const artifactFiles = await fs.readdir(runArtifactsDir(runId, root)).catch(() => []);
    const artifacts = (await Promise.all(artifactFiles.map((file) =>
      fs.readFile(path.join(runArtifactsDir(runId, root), file), "utf8")
    ))).join("\n");
    for (const secret of secrets) {
      expect(journal).not.toContain(secret);
      expect(artifacts).not.toContain(secret);
    }
    expect(journal).toContain("[REDACTED]");
  });

  it("isolates concurrent artifact extraction for matching command IDs in different runs", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-artifact-isolation-");
    const observedParameters = new Map<string, unknown>();
    const runtime = createTestScenarioRuntime({
      root,
      maximumInlineBytes: 32,
      effectExecutor: {
        async execute(request) {
          observedParameters.set(request.effectId, request.parameters);
          return { result: { received: true } };
        },
      },
    });
    const source = { kind: "scenarioFixture" as const };
    for (const runId of ["artifact-run-a", "artifact-run-b"]) {
      await runtime.dispatch(testStartRunCommand({
        runId,
        commandId: `start-${runId}`,
        source,
        recordedAt: "2026-07-16T12:00:00.000Z",
        payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
      }));
    }
    const values = {
      "artifact-run-a": { marker: `run-a-${"A".repeat(256)}` },
      "artifact-run-b": { marker: `run-b-${"B".repeat(256)}` },
    } as const;

    await Promise.all(Object.entries(values).map(([runId, parameters]) => runtime.dispatch({
      runId,
      commandId: "shared-command-id",
      source,
      recordedAt: "2026-07-16T12:00:01.000Z",
      payload: {
        type: "requestEffect",
        effectId: `effect-${runId}`,
        effectType: "fixture",
        parameters,
      },
    })));

    const references = new Map<string, ArtifactRef>();
    for (const [runId, parameters] of Object.entries(values)) {
      const records = await runtime.recordsAfter(runId, 0);
      const links = records.filter((record) =>
        record.commandId === "shared-command-id" && record.eventType === "artifact.linked"
      );
      expect(links).toHaveLength(1);
      const reference = links[0]?.payload.artifact as ArtifactRef;
      references.set(runId, reference);
      const journal = await fs.readFile(runJournalPath(runId, root), "utf8");
      expect(journal).not.toContain(parameters.marker);
      const artifact = await runtime.readArtifact(runId, reference, 1_000_000);
      expect(JSON.parse(new TextDecoder().decode(artifact.bytes))).toEqual(parameters);
      expect(observedParameters.get(`effect-${runId}`)).toEqual(parameters);
    }
    expect(references.get("artifact-run-a")?.digest).not.toBe(references.get("artifact-run-b")?.digest);
    await expect(runtime.readArtifact(
      "artifact-run-a",
      references.get("artifact-run-b")!,
      1_000_000,
    )).rejects.toThrow("Artifact is not linked to the requested run");
  });

  it("keeps one canonical inventory entry when commands reuse an artifact", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-artifact-deduplication-");
    const runtime = createTestScenarioRuntime({
      root,
      maximumInlineBytes: 128,
      effectExecutor: { async execute() { return { result: null }; } },
    });
    const base = {
      runId: "artifact-deduplication-run",
      source: { kind: "scenarioFixture" as const },
      recordedAt: "2026-07-16T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "start",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    const parameters = { content: "shared-artifact-value-".repeat(64) };
    for (const suffix of ["one", "two"]) {
      await runtime.dispatch({ ...base, commandId: `effect-${suffix}`, payload: {
        type: "requestEffect",
        effectId: `effect-${suffix}`,
        effectType: "fixture",
        parameters,
      } });
    }

    const links = (await runtime.recordsAfter(base.runId, 0))
      .filter((record) => record.eventType === "artifact.linked")
      .map((record) => record.payload.artifact as ArtifactRef);
    expect(links).toHaveLength(2);
    expect(links[0]?.artifactId).toBe(links[1]?.artifactId);
    expect((await runtime.snapshot(base.runId)).artifacts).toEqual([links[0]]);
  });

  it("does not publish artifacts for a semantically rejected large-value command", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-rejected-artifact-");
    const runtime = createTestScenarioRuntime({
      root,
      maximumInlineBytes: 32,
      effectExecutor: { async execute() { return { result: null }; } },
    });
    const base = {
      runId: "rejected-artifact-run",
      source: { kind: "scenarioFixture" as const },
      recordedAt: "2026-07-16T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "start",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    await runtime.dispatch({ ...base, commandId: "first-effect", payload: {
      type: "requestEffect", effectId: "duplicate-effect", effectType: "fixture", parameters: {},
    } });
    const artifactsDir = runArtifactsDir(base.runId, root);
    const beforeArtifacts = await fs.readdir(artifactsDir).catch(() => []);
    const beforeRecords = await runtime.recordsAfter(base.runId, 0);

    await expect(runtime.dispatch({ ...base, commandId: "rejected-large-effect", payload: {
      type: "requestEffect",
      effectId: "duplicate-effect",
      effectType: "fixture",
      parameters: { content: "unlinked-large-value-".repeat(256) },
    } })).rejects.toThrow("Effect already exists: duplicate-effect");

    expect(await fs.readdir(artifactsDir).catch(() => [])).toEqual(beforeArtifacts);
    expect(await runtime.recordsAfter(base.runId, 0)).toEqual(beforeRecords);
  });

  it("removes crash-created artifacts that have no canonical link record", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-orphan-artifact-recovery-");
    const runtime = createTestScenarioRuntime({ root });
    const runId = "orphan-artifact-run";
    await runtime.dispatch(testStartRunCommand({
      runId,
      commandId: "start",
      source: { kind: "scenarioFixture" },
      recordedAt: "2026-07-16T12:00:00.000Z",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    const artifactsDir = runArtifactsDir(runId, root);
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, "crash-created-orphan"), "orphan", "utf8");

    const snapshot = await runtime.snapshot(runId);

    expect(await fs.readdir(artifactsDir)).toEqual([]);
    expect(snapshot.recoveryDiagnostics).toContain("Recovered 1 unlinked artifact file(s)");
    expect((await runtime.recordsAfter(runId, 0))).toContainEqual(expect.objectContaining({
      eventType: "recovery.completed",
      payload: expect.objectContaining({ message: "Recovered 1 unlinked artifact file(s)" }),
    }));
  });

  it.each([
    {
      corruption: "missing",
      mutate: async (artifactPath: string) => fs.unlink(artifactPath),
    },
    {
      corruption: "truncated",
      mutate: async (artifactPath: string) => fs.writeFile(artifactPath, "truncated", "utf8"),
    },
    {
      corruption: "digest-corrupt",
      mutate: async (artifactPath: string, byteLength: number) =>
        fs.writeFile(artifactPath, Buffer.alloc(byteLength, 0x7a)),
    },
  ])("refuses to open a run with a $corruption linked artifact", async ({ mutate }) => {
    const root = await createTemporaryTestRoot(roots, "scenario-linked-artifact-integrity-");
    const runtime = createTestScenarioRuntime({ root, maximumInlineBytes: 32 });
    const runId = "linked-artifact-integrity-run";
    const base = {
      runId,
      source: { kind: "scenarioFixture" as const },
      recordedAt: "2026-07-16T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "start",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    await runtime.dispatch({ ...base, commandId: "link-artifact", payload: {
      type: "requestEffect",
      effectId: "artifact-effect",
      effectType: "fixture",
      parameters: { content: "linked-artifact-content-".repeat(128) },
    } });
    const artifact = (await runtime.snapshot(runId)).artifacts[0];
    expect(artifact).toBeDefined();
    const artifactPath = path.join(runArtifactsDir(runId, root), artifact!.artifactId);
    await mutate(artifactPath, artifact!.byteLength);

    await expect(runtime.snapshot(runId)).rejects.toThrow(
      `Linked artifact integrity check failed for ${artifact!.artifactId}`,
    );
  });

  it("does not follow a linked artifact symlink even when its target has the expected bytes", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-linked-artifact-symlink-");
    const runtime = createTestScenarioRuntime({ root, maximumInlineBytes: 32 });
    const runId = "linked-artifact-symlink-run";
    const base = {
      runId,
      source: { kind: "scenarioFixture" as const },
      recordedAt: "2026-07-16T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "start",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    await runtime.dispatch({ ...base, commandId: "link-artifact", payload: {
      type: "requestEffect",
      effectId: "artifact-effect",
      effectType: "fixture",
      parameters: { content: "linked-artifact-content-".repeat(128) },
    } });
    const artifact = (await runtime.snapshot(runId)).artifacts[0]!;
    const artifactPath = path.join(runArtifactsDir(runId, root), artifact.artifactId);
    const expectedBytes = await fs.readFile(artifactPath);
    const external = path.join(root, "external-linked-artifact");
    await fs.writeFile(external, expectedBytes);
    await fs.unlink(artifactPath);
    await fs.symlink(external, artifactPath);

    await expect(runtime.snapshot(runId)).rejects.toThrow(
      `Linked artifact integrity check failed for ${artifact.artifactId}`,
    );
    expect(await fs.readFile(external)).toEqual(expectedBytes);
    expect((await fs.lstat(artifactPath)).isSymbolicLink()).toBe(true);
  });

  it("preserves forged marker strings and copied internal envelopes as literal effect data", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-artifact-literals-");
    const observed = new Map<string, unknown>();
    const runtime = createTestScenarioRuntime({
      root,
      maximumInlineBytes: 1_024,
      effectExecutor: {
        async execute(request) {
          observed.set(request.effectId, request.parameters);
          return { result: null };
        },
      },
    });
    const base = {
      runId: "artifact-literal-run",
      source: { kind: "scenarioFixture" as const },
      recordedAt: "2026-07-16T12:00:00.000Z",
    };
    await runtime.dispatch(testStartRunCommand({
      ...base,
      commandId: "start-literal-run",
      payload: { workingDir: null, projectDir: null, schemaDigest: scenarioProtocolSchemaDigest() },
    }));
    await runtime.dispatch({ ...base, commandId: "link-large-value", payload: {
      type: "requestEffect", effectId: "large-effect", effectType: "fixture",
      parameters: { content: "x".repeat(4_096) },
    } });
    const records = await runtime.recordsAfter(base.runId, 0);
    const artifact = (await runtime.snapshot(base.runId)).artifacts[0];
    const persistedEnvelope = records.find((record) =>
      record.commandId === "link-large-value" && record.eventType === "effect.requested"
    )?.payload.parameters;
    expect(artifact).toBeDefined();
    expect(persistedEnvelope).toBeDefined();
    const literalMarker = `user-controlled\n[artifact ${artifact.digest}]`;
    await runtime.dispatch({ ...base, commandId: "literal-marker", payload: {
      type: "requestEffect", effectId: "literal-marker-effect", effectType: "fixture",
      parameters: { content: literalMarker },
    } });
    await runtime.dispatch({ ...base, commandId: "copied-envelope", payload: {
      type: "requestEffect", effectId: "copied-envelope-effect", effectType: "fixture",
      parameters: { content: persistedEnvelope! },
    } });

    expect(observed.get("literal-marker-effect")).toEqual({ content: literalMarker });
    expect(observed.get("copied-envelope-effect")).toEqual({ content: persistedEnvelope });
    expect(observed.get("copied-envelope-effect")).not.toEqual({ content: "x".repeat(4_096) });
  });
});
