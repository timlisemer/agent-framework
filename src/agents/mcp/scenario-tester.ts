/** Canonical Scenario fixture MCP. This is deliberately independent of labeled transcript replay. */
import * as fs from "fs";
import * as path from "path";
import {
  materializeScenarioFixture,
  runScenarioFixture,
  validateScenarioFixture,
  type ScenarioFixtureReport,
  type ScenarioFixture,
} from "../../scenario/fixtures/index.js";
import { RulePipelineEffectExecutor } from "../../effects/rule-pipeline-executor.js";
import { agentFrameworkScenarioFixturePolicy } from "../../effects/scenario-fixture-policy.js";
import { createAgentFrameworkScenarioRuntime } from "../../effects/scenario-runtime-factory.js";
import {
  SCENARIO_SOURCE_TAGS,
  type ScenarioCatalogEntry,
  type ScenarioSourceTag,
} from "./scenario-catalog.js";
import { VERSION } from "../../version.js";
import { writeJsonAtomic } from "../../utils/file-io.js";
import { errorMessage } from "../../utils/output.js";
import { isScenarioName, requireScenarioName } from "../../scenario/name.js";
import { scenarioRunDir, scenariosRoot } from "../../utils/paths.js";

const FIXTURE_FILE = "fixture.json";
const REPORT_FILE = "report.json";

export const SCENARIO_TESTER_ACTIONS = [
  "list_fixtures",
  "read_fixture",
  "run_fixture",
  "run_fixtures",
  "inspect_report",
  "materialize_scenario",
  "git_hash",
  "help",
] as const;

type FixtureSource = ScenarioCatalogEntry & {
  fixture?: ScenarioFixture;
};

export interface TesterInput {
  action: string;
  working_dir?: string;
  scenario_name?: string;
  scenario_names?: string[];
  scenario_source?: ScenarioSourceTag;
  scenario?: unknown;
  run_id?: string;
  runtime_root?: string;
  run_materialized?: boolean;
}

export async function handleScenarioTester(input: TesterInput): Promise<string> {
  try {
    switch (input.action) {
      case "list_fixtures":
        return JSON.stringify(listFixtures(input.working_dir, input.scenario_source).map(publicSource), null, 2);
      case "read_fixture":
        return JSON.stringify(readFixture(requiredName(input), input.working_dir), null, 2);
      case "run_fixture":
        return JSON.stringify(await runOneFixture(input), null, 2);
      case "run_fixtures":
        return JSON.stringify(await runManyFixtures(input), null, 2);
      case "inspect_report":
        return readReport(requiredName(input));
      case "materialize_scenario":
        return JSON.stringify(await materializeFixture(input), null, 2);
      case "git_hash":
        return VERSION;
      case "help":
        return TESTER_HELP;
      default:
        throw new Error(`Unknown action: "${input.action}". Valid actions: ${SCENARIO_TESTER_ACTIONS.join(", ")}`);
    }
  } catch (error: unknown) {
    return `ERROR: ${errorMessage(error, "Scenario tester error")}`;
  }
}

function requiredName(input: TesterInput): string {
  if (!input.scenario_name) throw new Error("scenario_name is required");
  return requireScenarioName(input.scenario_name);
}

function listFixtures(workingDir?: string, sourceFilter?: ScenarioSourceTag): FixtureSource[] {
  const result = new Map<string, FixtureSource>();
  const add = (entry: FixtureSource): void => {
    const prior = result.get(entry.name);
    if (prior) {
      throw new Error(
        `fixture slug "${entry.name}" exists in multiple sources: ` +
        `${prior.source} (${prior.inputPath}) and ${entry.source} (${entry.inputPath})`,
      );
    }
    result.set(entry.name, entry);
  };

  const homeRoot = scenariosRoot();
  if (fs.existsSync(homeRoot)) {
    for (const name of fs.readdirSync(homeRoot).sort()) {
      if (!isScenarioName(name)) continue;
      const fixturePath = path.join(homeRoot, name, FIXTURE_FILE);
      if (!fs.existsSync(fixturePath)) continue;
      add(loadSource(name, "home", fixturePath, path.join(homeRoot, name)));
    }
  }

  const repositoryRoot = workingDir ?? process.env.AGENT_FRAMEWORK_ROOT ?? process.cwd();
  for (const source of SCENARIO_SOURCE_TAGS) {
    if (source === "home") continue;
    const directory = path.join(repositoryRoot, "scenarios", source);
    if (!fs.existsSync(directory)) continue;
    for (const file of fs.readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
      const name = file.slice(0, -5);
      if (!isScenarioName(name)) continue;
      add(loadSource(name, source, path.join(directory, file), scenarioRunDir(name)));
    }
  }
  return [...result.values()]
    .filter((entry) => sourceFilter === undefined || entry.source === sourceFilter)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function loadSource(
  name: string,
  source: ScenarioSourceTag,
  inputPath: string,
  outputDir: string,
  initialError?: string,
): FixtureSource {
  try {
    if (initialError) throw new Error(initialError);
    const fixture = validateScenarioFixture(JSON.parse(fs.readFileSync(inputPath, "utf8")));
    if (fixture.name !== name) {
      throw new Error(`fixture name ${JSON.stringify(fixture.name)} must equal filename slug ${JSON.stringify(name)}`);
    }
    return { name, source, inputPath, outputDir, fixture };
  } catch (error) {
    return {
      name,
      source,
      inputPath,
      outputDir,
      error: errorMessage(error, "Scenario fixture load failed"),
    };
  }
}

function readFixture(name: string, workingDir?: string): Record<string, unknown> {
  const source = findFixture(name, workingDir);
  return { ...publicSource(source), fixture: requireValidFixture(source) };
}

function runAgentFrameworkFixture(fixture: ScenarioFixture) {
  return runScenarioFixture(fixture, {
    policy: agentFrameworkScenarioFixturePolicy,
    ...(fixture.effects.mode === "live"
      ? { liveEffectExecutor: new RulePipelineEffectExecutor() }
      : {}),
  });
}

async function runOneFixture(input: TesterInput): Promise<Record<string, unknown>> {
  const source = input.scenario === undefined
    ? findFixture(requiredName(input), input.working_dir)
    : storeInlineFixture(input.scenario, input.scenario_name);
  const fixture = requireValidFixture(source);
  const report = await runAgentFrameworkFixture(fixture);
  writeReport(source.name, report);
  return { source: source.source, report };
}

async function runManyFixtures(input: TesterInput): Promise<Record<string, unknown>> {
  const all = listFixtures(input.working_dir, input.scenario_source);
  const wanted = input.scenario_names?.length
    ? new Set(input.scenario_names.map(requireScenarioName))
    : undefined;
  const selected = wanted ? all.filter((entry) => wanted.has(entry.name)) : all;
  if (wanted) {
    const found = new Set(selected.map((entry) => entry.name));
    const missing = [...wanted].filter((name) => !found.has(name));
    if (missing.length > 0) throw new Error(`fixtures not found in selected source: ${missing.join(", ")}`);
  }
  const results = await Promise.all(selected.map(async (source) => {
    if (source.error) return { name: source.name, source: source.source, pass: false, error: source.error };
    try {
      const fixture = requireValidFixture(source);
      const report = await runAgentFrameworkFixture(fixture);
      writeReport(source.name, report);
      return { name: source.name, source: source.source, pass: report.pass, report };
    } catch (error) {
      return {
        name: source.name,
        source: source.source,
        pass: false,
        error: errorMessage(error, "Scenario fixture run failed"),
      };
    }
  }));
  return {
    total: results.length,
    passed: results.filter((result) => result.pass).length,
    failed: results.filter((result) => !result.pass).length,
    results,
  };
}

async function materializeFixture(input: TesterInput): Promise<Record<string, unknown>> {
  if (!input.run_id) throw new Error("run_id is required");
  const runtime = createAgentFrameworkScenarioRuntime(input.runtime_root ? { root: input.runtime_root } : {});
  const fixture = await materializeScenarioFixture(runtime, input.run_id, {
    policy: agentFrameworkScenarioFixturePolicy,
    ...(input.scenario_name ? { name: input.scenario_name } : {}),
  });
  const source = storeCanonicalFixture(fixture);
  const response: Record<string, unknown> = {
    ...publicSource(source),
    fixture,
  };
  if (input.run_materialized) {
    const report = await runAgentFrameworkFixture(fixture);
    writeReport(fixture.name, report);
    response.report = report;
  }
  return response;
}

function storeInlineFixture(input: unknown, expectedName?: string): FixtureSource {
  const fixture = validateScenarioFixture(input);
  if (expectedName !== undefined && fixture.name !== expectedName) {
    throw new Error(`scenario_name ${JSON.stringify(expectedName)} must equal fixture.name ${JSON.stringify(fixture.name)}`);
  }
  return storeCanonicalFixture(fixture);
}

function storeCanonicalFixture(fixture: ScenarioFixture): FixtureSource {
  const validated = validateScenarioFixture(fixture);
  const directory = scenarioRunDir(validated.name);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const inputPath = path.join(directory, FIXTURE_FILE);
  writeJsonAtomic(inputPath, validated, { mode: 0o600 });
  return { name: validated.name, source: "home", inputPath, outputDir: directory, fixture: validated };
}

function findFixture(name: string, workingDir?: string): FixtureSource {
  const source = listFixtures(workingDir).find((entry) => entry.name === name);
  if (!source) throw new Error(`fixture "${name}" not found`);
  return source;
}

function requireValidFixture(source: FixtureSource): ScenarioFixture {
  if (source.error) throw new Error(`fixture "${source.name}" is malformed: ${source.error}`);
  if (!source.fixture) throw new Error(`fixture "${source.name}" was not loaded`);
  return source.fixture;
}

function writeReport(name: string, report: ScenarioFixtureReport): void {
  const directory = scenarioRunDir(name);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeJsonAtomic(path.join(directory, REPORT_FILE), report, { mode: 0o600 });
}

function readReport(name: string): string {
  const reportPath = path.join(scenarioRunDir(name), REPORT_FILE);
  if (!fs.existsSync(reportPath)) throw new Error(`${REPORT_FILE} not found for fixture "${name}"`);
  return fs.readFileSync(reportPath, "utf8");
}

function publicSource(source: FixtureSource): Record<string, unknown> {
  return {
    name: source.name,
    source: source.source,
    input_path: source.inputPath,
    report_path: path.join(source.outputDir, REPORT_FILE),
    ...(source.error ? { error: source.error } : {}),
  };
}

export const TESTER_HELP = `# Scenario Tester

The tester operates on canonical Scenario fixtures and canonical run journals. It does not create, read, or score transcript label files.

Actions:
- list_fixtures: list home and repository fixtures. Optional scenario_source and working_dir.
- read_fixture: return the canonical fixture for scenario_name.
- run_fixture: run scenario_name, or validate/store/run an inline scenario. This is the primary deterministic lane.
- run_fixtures: run scenario_names, or every fixture when omitted.
- inspect_report: read report.json for scenario_name.
- materialize_scenario: materialize run_id from the canonical journal.
- git_hash, help.
`;
