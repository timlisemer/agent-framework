import {
  ScenarioEffectCancellationError,
  type ScenarioEffectExecutor,
  type ScenarioEffectRequest,
} from "../runtime/effects.js";
import { ScenarioRuntime } from "../runtime/runtime.js";
import type { ScenarioTerminalResult } from "../runtime/results.js";
import type { FixtureEffectPolicy, ScenarioFixtureReport } from "./types.js";
import { evaluateFixtureExpectations, validateScenarioFixture } from "./validator.js";
import type { ScenarioFixturePolicy } from "./policy.js";
import {
  createTemporaryDirectory,
  withTemporaryDirectory,
} from "../../utils/temporary-directory.js";

export type ScenarioFixtureRunnerOptions = {
  root?: string;
  liveEffectExecutor?: ScenarioEffectExecutor;
  retainTemporaryRoot?: boolean;
  policy?: ScenarioFixturePolicy;
};

export async function runScenarioFixture(
  input: unknown,
  options: ScenarioFixtureRunnerOptions = {},
): Promise<ScenarioFixtureReport> {
  const fixture = validateScenarioFixture(input);
  if (options.root !== undefined) return executeScenarioFixture(fixture, options.root, options);
  if (options.retainTemporaryRoot === true) {
    const root = await createTemporaryDirectory({ prefix: "scenario-fixture-" });
    return executeScenarioFixture(fixture, root, options);
  }
  return withTemporaryDirectory(
    { prefix: "scenario-fixture-" },
    (root) => executeScenarioFixture(fixture, root, options),
  );
}

async function executeScenarioFixture(
  fixture: ReturnType<typeof validateScenarioFixture>,
  root: string,
  options: ScenarioFixtureRunnerOptions,
): Promise<ScenarioFixtureReport> {
  const executor = effectExecutor(fixture.effects, options.liveEffectExecutor, options.policy);
  const runtime = new ScenarioRuntime({
    root,
    effectExecutor: executor,
    effectPlanner: options.policy?.effectPlanner,
    extensionHandler: options.policy?.extensionHandler,
    stateSlicePolicy: options.policy?.stateSlicePolicy,
  });
  const commandResults: Record<string, ScenarioTerminalResult> = {};
  const { startCommand, snapshot, seedRecords } = fixture.initialRun;
  if (snapshot || seedRecords.length > 0) {
    await runtime.initializeSeededRun(startCommand, seedRecords, snapshot);
  } else {
    commandResults[startCommand.commandId] = await runtime.dispatch(startCommand);
  }
  for (const command of fixture.commands) {
    commandResults[command.commandId] = await runtime.dispatch(command);
  }
  const finalSnapshot = await runtime.snapshot(startCommand.runId);
  const records = await runtime.recordsAfter(startCommand.runId, 0);
  const expectationResults = evaluateFixtureExpectations(
    fixture.expectations,
    records,
    finalSnapshot,
  );
  return {
    fixtureName: fixture.name,
    runId: startCommand.runId,
    pass: expectationResults.every((result) => result.pass),
    commandResults,
    expectationResults,
    finalSnapshot,
    records,
  };
}

function effectExecutor(
  policy: FixtureEffectPolicy,
  liveExecutor: ScenarioEffectExecutor | undefined,
  fixturePolicy: ScenarioFixturePolicy | undefined,
): ScenarioEffectExecutor {
  if (policy.mode === "live") {
    if (!liveExecutor) throw new Error("Live-effect fixture requires liveEffectExecutor");
    return liveExecutor;
  }
  return {
    async execute(request: ScenarioEffectRequest) {
      const outcome = policy.outcomes[request.effectId];
      if (!outcome && policy.allowUndeclaredToolPolicy) {
        const defaultResult = await fixturePolicy?.defaultUndeclaredEffect?.(request);
        if (defaultResult !== null && defaultResult !== undefined) return defaultResult;
      }
      if (!outcome) {
        if (policy.rejectUnexpected) throw new Error(`Unexpected fixture effect: ${request.effectId}`);
        return { result: null, metadata: { fixtureDefault: true } };
      }
      if (outcome.outcome === "failed") throw new Error(outcome.error);
      if (outcome.outcome === "cancelled") throw new ScenarioEffectCancellationError(outcome.reason);
      const projection = await fixturePolicy?.projectDeterministicEffect?.(request, outcome.result);
      return {
        result: outcome.result,
        ...(projection === undefined ? {} : { projection }),
        ...(outcome.metadata === undefined ? {} : { metadata: outcome.metadata }),
      };
    },
  };
}
