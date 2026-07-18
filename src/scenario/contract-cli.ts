import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { materializeScenarioFixture } from "./fixtures/materialize.js";
import { scenarioCommandSchema, type ScenarioCommand } from "./protocol/commands.js";
import { buildScenarioProtocolArtifacts } from "./protocol/generated-artifacts.js";
import { scenarioSnapshotSchema } from "./protocol/snapshot.js";
import { ScenarioRuntime } from "./runtime/runtime.js";
import { pathExists, writeFileAtomically } from "../utils/file-io.js";
import { withCleanup } from "../utils/resource-lifecycle.js";

async function main(): Promise<void> {
  const [operation, ...args] = process.argv.slice(2);
  const output = await runScenarioContractOperation(operation, args);
  if (output !== null) process.stdout.write(`${output}\n`);
}

/** Execute one compiled contract operation without coupling tests or consumers to process globals. */
export async function runScenarioContractOperation(
  operation: string | undefined,
  args: string[],
): Promise<string | null> {
  if (operation === "export-schema") {
    const [destination] = requireArguments(operation, args, 1);
    await exportSchema(path.resolve(destination));
    return null;
  }
  if (operation === "validate-snapshot") {
    const [snapshotPath] = requireArguments(operation, args, 1);
    scenarioSnapshotSchema.parse(JSON.parse(await fs.readFile(path.resolve(snapshotPath), "utf8")));
    return null;
  }
  if (operation === "apply-commands") {
    const [runRoot, commandsPath] = requireArguments(operation, args, 2);
    const runtime = new ScenarioRuntime({ root: path.resolve(runRoot) });
    const commands = await readCommands(path.resolve(commandsPath));
    for (const command of commands) await runtime.replayCommand(command);
    return JSON.stringify(await runtime.snapshot(commands.at(-1)!.runId));
  }
  if (operation === "materialize") {
    const [runRoot, runId, name] = requireArguments(operation, args, 3);
    const fixture = await materializeContractScenario(path.resolve(runRoot), runId, name);
    return JSON.stringify(fixture);
  }
  throw new Error(
    "usage: scenario:contract " +
    "<export-schema <directory>|validate-snapshot <snapshot-path>|" +
    "apply-commands <run-root> <commands-path>|materialize <run-root> <run-id> <name>>",
  );
}

export async function materializeContractScenario(
  runRoot: string,
  runId: string,
  name: string,
) {
  const runtime = new ScenarioRuntime({ root: runRoot });
  return materializeScenarioFixture(runtime, runId, { name });
}

type ContractSchemaPublicationOptions = {
  rename?: typeof fs.rename;
  remove?: typeof fs.rm;
};

/** Publish a complete contract bundle while preserving any prior generation on failure. */
export async function exportScenarioContractSchema(
  destination: string,
  options: ContractSchemaPublicationOptions = {},
): Promise<void> {
  const rename = options.rename ?? fs.rename;
  const remove = options.remove ?? fs.rm;
  const parent = path.dirname(destination);
  const bundleName = path.basename(destination);
  await fs.mkdir(parent, { recursive: true });
  const artifacts = [...buildScenarioProtocolArtifacts()];
  const stagingDirectory = await fs.mkdtemp(path.join(parent, `.${bundleName}.staging-`));
  let backupDirectory: string | null = null;
  let previousBundle: string | null = null;
  let removeBackup = true;
  await withCleanup(async () => {
    await Promise.all(artifacts.map(([name, contents]) =>
      writeFileAtomically(path.join(stagingDirectory, name), contents)
    ));
    if (await pathExists(destination)) {
      backupDirectory = await fs.mkdtemp(path.join(parent, `.${bundleName}.backup-`));
      previousBundle = path.join(backupDirectory, bundleName);
      await rename(destination, previousBundle);
    }
    try {
      await rename(stagingDirectory, destination);
    } catch (error) {
      if (previousBundle !== null) {
        try {
          await rename(previousBundle, destination);
          previousBundle = null;
        } catch (rollbackError) {
          removeBackup = false;
          throw new AggregateError(
            [error, rollbackError],
            `Contract publication failed and the prior bundle remains at ${previousBundle}`,
          );
        }
      }
      throw error;
    }
  }, async () => {
    const failures: unknown[] = [];
    try {
      await remove(stagingDirectory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (backupDirectory !== null && removeBackup) {
      try {
        await remove(backupDirectory, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Contract publication cleanup failed");
  });
}

async function exportSchema(destination: string): Promise<void> {
  await exportScenarioContractSchema(destination);
}

async function readCommands(commandsPath: string): Promise<ScenarioCommand[]> {
  const value: unknown = JSON.parse(await fs.readFile(commandsPath, "utf8"));
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Scenario command input must be a non-empty JSON array");
  }
  return value.map((command) => scenarioCommandSchema.parse(command));
}

function requireArguments(
  operation: string,
  args: string[],
  count: number,
): string[] {
  if (args.length !== count) {
    throw new Error(`scenario:contract ${operation} requires exactly ${count} argument(s)`);
  }
  return args;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
