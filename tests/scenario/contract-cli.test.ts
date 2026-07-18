import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportScenarioContractSchema,
  runScenarioContractOperation,
} from "../../src/scenario/contract-cli.js";
import {
  SCENARIO_PROTOCOL_ARTIFACT_NAMES,
} from "../../src/scenario/protocol/generated-artifacts.js";
import { scenarioProtocolSchemaDigest } from "../../src/scenario/protocol/schema.js";
import {
  testScenarioCommand,
  testStartRunCommand,
} from "../helpers/scenario-fixtures.js";
import {
  cleanupTemporaryTestRoots,
  createTemporaryTestRoot,
} from "../helpers/temporary-root.js";

const roots: string[] = [];

afterEach(async () => {
  await cleanupTemporaryTestRoots(roots);
});

describe("Scenario contract CLI", () => {
  it("replaces a contract bundle coherently and restores it after publication failure", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-contract-publication-");
    const exportRoot = path.join(root, "contract");
    await exportScenarioContractSchema(exportRoot);
    await expect(exportScenarioContractSchema(exportRoot)).resolves.toBeUndefined();
    const previous = new Map(await Promise.all(SCENARIO_PROTOCOL_ARTIFACT_NAMES.map(async (name) => [
      name,
      await fs.readFile(path.join(exportRoot, name), "utf8"),
    ] as const)));
    let replacementAttempted = false;

    await expect(exportScenarioContractSchema(exportRoot, {
      rename: async (source, destination) => {
        if (String(destination) === exportRoot && String(source).includes(".contract.staging-")) {
          replacementAttempted = true;
          throw new Error("simulated contract publication failure");
        }
        await fs.rename(source, destination);
      },
    })).rejects.toThrow("simulated contract publication failure");

    expect(replacementAttempted).toBe(true);
    await expect(fs.readdir(exportRoot)).resolves.toEqual(
      expect.arrayContaining([...SCENARIO_PROTOCOL_ARTIFACT_NAMES]),
    );
    for (const [name, contents] of previous) {
      await expect(fs.readFile(path.join(exportRoot, name), "utf8")).resolves.toBe(contents);
    }
  });

  it("preserves the publication failure when staging cleanup also fails", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-contract-cleanup-precedence-");
    const exportRoot = path.join(root, "contract");
    await exportScenarioContractSchema(exportRoot);
    const publicationFailure = new Error("primary contract publication failure");
    const cleanupFailure = new Error("secondary staging cleanup failure");
    let surfaced: unknown;

    try {
      await exportScenarioContractSchema(exportRoot, {
        rename: async (source, destination) => {
          if (String(destination) === exportRoot && String(source).includes(".contract.staging-")) {
            throw publicationFailure;
          }
          await fs.rename(source, destination);
        },
        remove: async (target, options) => {
          if (String(target).includes(".contract.staging-")) throw cleanupFailure;
          await fs.rm(target, options);
        },
      });
    } catch (error) {
      surfaced = error;
    }

    expect(surfaced).toBe(publicationFailure);
    await expect(fs.readdir(exportRoot)).resolves.toEqual(
      expect.arrayContaining([...SCENARIO_PROTOCOL_ARTIFACT_NAMES]),
    );
  });

  it("preserves rollback details and the retained bundle path when staging cleanup fails", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-contract-rollback-precedence-");
    const exportRoot = path.join(root, "contract");
    await exportScenarioContractSchema(exportRoot);
    const publicationFailure = new Error("primary replacement failure");
    const rollbackFailure = new Error("secondary rollback failure");
    const cleanupFailure = new Error("tertiary staging cleanup failure");
    let surfaced: unknown;

    try {
      await exportScenarioContractSchema(exportRoot, {
        rename: async (source, destination) => {
          if (String(destination) === exportRoot && String(source).includes(".contract.staging-")) {
            throw publicationFailure;
          }
          if (String(destination) === exportRoot && String(source).includes(".contract.backup-")) {
            throw rollbackFailure;
          }
          await fs.rename(source, destination);
        },
        remove: async (target, options) => {
          if (String(target).includes(".contract.staging-")) throw cleanupFailure;
          await fs.rm(target, options);
        },
      });
    } catch (error) {
      surfaced = error;
    }

    expect(surfaced).toBeInstanceOf(AggregateError);
    const aggregate = surfaced as AggregateError;
    expect(aggregate.errors).toEqual([publicationFailure, rollbackFailure]);
    expect(aggregate.message).toContain("Contract publication failed and the prior bundle remains at");
    const retainedBackup = (await fs.readdir(root)).find((entry) => entry.includes(".contract.backup-"));
    expect(retainedBackup).toBeDefined();
    await expect(fs.readdir(path.join(root, retainedBackup!, "contract"))).resolves.toEqual(
      expect.arrayContaining([...SCENARIO_PROTOCOL_ARTIFACT_NAMES]),
    );
  });

  it("exports schemas, applies commands, validates snapshots, and materializes fixtures", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-contract-cli-");
    const exportRoot = path.join(root, "contract");
    await expect(runScenarioContractOperation("export-schema", [exportRoot])).resolves.toBeNull();
    await expect(fs.readdir(exportRoot)).resolves.toEqual(
      expect.arrayContaining([...SCENARIO_PROTOCOL_ARTIFACT_NAMES]),
    );
    await expect(fs.readFile(path.join(exportRoot, "schema-digest.txt"), "utf8"))
      .resolves.toBe(`${scenarioProtocolSchemaDigest()}\n`);

    const runRoot = path.join(root, "runs");
    const commandsPath = path.join(root, "commands.json");
    const startCommand = testStartRunCommand({ runId: "contract-cli-run" });
    await fs.writeFile(commandsPath, JSON.stringify([startCommand]), "utf8");
    const output = await runScenarioContractOperation("apply-commands", [runRoot, commandsPath]);
    const snapshot = JSON.parse(output!);
    expect(snapshot).toMatchObject({
      runId: startCommand.runId,
      status: "running",
      identity: { schemaDigest: scenarioProtocolSchemaDigest() },
    });

    const snapshotPath = path.join(root, "snapshot.json");
    await fs.writeFile(snapshotPath, output!, "utf8");
    await expect(runScenarioContractOperation("validate-snapshot", [snapshotPath]))
      .resolves.toBeNull();

    const fixtureOutput = await runScenarioContractOperation(
      "materialize",
      [runRoot, startCommand.runId, "contract-cli-fixture"],
    );
    expect(JSON.parse(fixtureOutput!)).toMatchObject({
      name: "contract-cli-fixture",
      initialRun: { startCommand: { runId: startCommand.runId } },
      commands: [],
    });
  });

  it("replays an explicit effect lifecycle without executing the outbox", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-contract-replay-");
    const runRoot = path.join(root, "runs");
    const commandsPath = path.join(root, "effect-commands.json");
    const runId = "contract-effect-replay";
    const commands = [
      testStartRunCommand({ runId }),
      testScenarioCommand(runId, "request-effect", {
        type: "requestEffect",
        effectId: "contract-effect",
        effectType: "contract.fixture",
        parameters: { operation: "replay" },
      }),
      testScenarioCommand(runId, "start-effect", {
        type: "effectStarted",
        effectId: "contract-effect",
        effectType: "contract.fixture",
        claimId: "contract-claim",
      }),
      testScenarioCommand(runId, "complete-effect", {
        type: "effectResultSupplied",
        effectId: "contract-effect",
        claimId: "contract-claim",
        result: { replayed: true },
        projection: {
          records: [],
          stateChanges: [{
            key: "contract.replay",
            schemaId: "contract://state/replay",
            status: "validated",
            source: "contract.applyCommands",
            visibility: "localSensitive",
            value: { completed: true },
            diagnostics: [],
          }],
          terminalResult: { status: "accepted" },
        },
      }),
    ];
    await fs.writeFile(commandsPath, JSON.stringify(commands), "utf8");

    const output = await runScenarioContractOperation("apply-commands", [runRoot, commandsPath]);
    const snapshot = JSON.parse(output!);

    expect(snapshot.effects).toContainEqual(expect.objectContaining({
      effectId: "contract-effect",
      status: "completed",
      result: { replayed: true },
    }));
    expect(snapshot.stateSlices["contract.replay"]).toMatchObject({
      status: "validated",
      value: { completed: true },
    });
  });

  it("rejects malformed command and snapshot input", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-contract-cli-");
    const malformedCommandsPath = path.join(root, "malformed-commands.json");
    await fs.writeFile(malformedCommandsPath, "not json", "utf8");
    await expect(runScenarioContractOperation(
      "apply-commands",
      [path.join(root, "runs"), malformedCommandsPath],
    )).rejects.toBeInstanceOf(SyntaxError);

    const emptyCommandsPath = path.join(root, "empty-commands.json");
    await fs.writeFile(emptyCommandsPath, "[]", "utf8");
    await expect(runScenarioContractOperation(
      "apply-commands",
      [path.join(root, "runs"), emptyCommandsPath],
    )).rejects.toThrow("Scenario command input must be a non-empty JSON array");

    const malformedSnapshotPath = path.join(root, "malformed-snapshot.json");
    await fs.writeFile(malformedSnapshotPath, JSON.stringify({ status: "running" }), "utf8");
    await expect(runScenarioContractOperation("validate-snapshot", [malformedSnapshotPath]))
      .rejects.toThrow();
  });

  it("rejects an incompatible digest before mutating the requested run root", async () => {
    const root = await createTemporaryTestRoot(roots, "scenario-contract-cli-");
    const runRoot = path.join(root, "runs");
    const commandsPath = path.join(root, "incompatible-commands.json");
    const incompatibleDigest = `sha256:${"0".repeat(64)}`;
    await fs.writeFile(commandsPath, JSON.stringify([
      testStartRunCommand({ payload: { schemaDigest: incompatibleDigest } }),
    ]), "utf8");

    await expect(runScenarioContractOperation("apply-commands", [runRoot, commandsPath]))
      .rejects.toThrow(
        `startRun schemaDigest must equal the current Scenario protocol digest ${scenarioProtocolSchemaDigest()}`,
      );
    await expect(fs.access(runRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
