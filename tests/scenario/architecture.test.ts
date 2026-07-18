import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  scenarioCommandPayloadSchema,
  scenarioCommandTypes,
} from "../../src/scenario/protocol/commands.js";
import { scenarioVisibilityValues } from "../../src/scenario/protocol/common.js";
import { buildScenarioProtocolManifest } from "../../src/scenario/protocol/schema.js";
import {
  scenarioGatewayOperations,
  scenarioGatewayOperationScopes,
  scenarioGatewayScopes,
} from "../../src/scenario/protocol/gateway.js";
import {
  MAXIMUM_ARTIFACT_BYTES,
  MAXIMUM_CLIENT_FRAME_BYTES,
} from "../../src/scenario/protocol/limits.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

function sourceFiles(relative: string): string[] {
  const absolute = path.join(ROOT, relative);
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) return sourceFiles(path.relative(ROOT, child));
    return entry.isFile() && entry.name.endsWith(".ts") ? [child] : [];
  });
}

function contents(files: readonly string[]): string {
  return files.map((file) => `// ${path.relative(ROOT, file)}\n${fs.readFileSync(file, "utf8")}`).join("\n");
}

describe("Scenario Magna Lingua dependency boundaries", () => {
  it("publishes every accepted command discriminator exactly once", () => {
    const accepted = scenarioCommandPayloadSchema.options.flatMap((option) =>
      option.shape.type instanceof z.ZodLiteral
        ? [...option.shape.type.values]
        : option.shape.type.options
    );
    const generated = JSON.parse(fs.readFileSync(
      path.join(ROOT, "src/scenario/protocol/generated/protocol-manifest.json"),
      "utf8",
    )) as { enumValues: { commandType: string[] } };

    expect(new Set(accepted).size).toBe(accepted.length);
    expect(scenarioCommandTypes).toEqual(accepted);
    expect(generated.enumValues.commandType).toEqual(accepted);
  });

  it("derives cross-repository protocol inventories from their schemas", () => {
    const manifest = buildScenarioProtocolManifest();
    const generated = JSON.parse(fs.readFileSync(
      path.join(ROOT, "src/scenario/protocol/generated/protocol-manifest.json"),
      "utf8",
    )) as {
      enumValues: { visibility: string[] };
      limits: {
        maximumClientFrameBytes: number;
        maximumArtifactBytes: number;
      };
      gatewayScopes: string[];
      gatewayOperationScopes: Record<string, string>;
    };

    expect(manifest.limits).toEqual({
      maximumClientFrameBytes: MAXIMUM_CLIENT_FRAME_BYTES,
      maximumArtifactBytes: MAXIMUM_ARTIFACT_BYTES,
    });
    expect(generated.limits).toEqual(manifest.limits);
    expect(manifest.enumValues.visibility).toEqual(scenarioVisibilityValues);
    expect(generated.enumValues.visibility).toEqual(scenarioVisibilityValues);
    expect(manifest.enumValues).not.toHaveProperty("runtimeHomeKind");
    expect(manifest.enumValues).not.toHaveProperty("providerSdkRuntime");
    expect(generated.enumValues).not.toHaveProperty("runtimeHomeKind");
    expect(generated.enumValues).not.toHaveProperty("providerSdkRuntime");
    expect(manifest.gatewayScopes).toEqual(scenarioGatewayScopes);
    expect(manifest.gatewayOperationScopes).toEqual(scenarioGatewayOperationScopes);
    expect(Object.keys(scenarioGatewayOperationScopes).sort()).toEqual([...scenarioGatewayOperations].sort());
    expect(generated.gatewayScopes).toEqual(scenarioGatewayScopes);
    expect(generated.gatewayOperationScopes).toEqual(scenarioGatewayOperationScopes);
  });

  it("keeps adapters, hooks, provider UI, and fixture expectations outside the runtime core", () => {
    const runtime = contents(sourceFiles("src/scenario/runtime"));
    expect(runtime).not.toMatch(/from ["'][^"']*\/adapter\//);
    expect(runtime).not.toMatch(/from ["'][^"']*\/hooks\//);
    expect(runtime).not.toMatch(/from ["'][^"']*\/agents\//);
    expect(runtime).not.toMatch(/fixtures\/expectations|WebSocket|GTK|Astral/);
  });

  it("keeps native hooks as thin boundary adapters", () => {
    const hooks = contents(sourceFiles("src/hooks"));
    expect(hooks).not.toMatch(/rules\/evaluator|gate-reasoning-cache|tool-log-types/);
    for (const entrypoint of [
      "pre-tool-use.ts",
      "user-prompt-submit.ts",
      "stop-response-check.ts",
      "post-tool-use.ts",
      "post-tool-use-failure.ts",
      "session-start.ts",
    ]) {
      expect(fs.readFileSync(path.join(ROOT, "src/hooks", entrypoint), "utf8"))
        .toContain("../entrypoints/host-hook.js");
    }
  });

  it("uses canonical workflow state for host runs", () => {
    expect(sourceFiles("src/effects").some((file) => file.endsWith("session-workflow.ts")))
      .toBe(true);
    expect(fs.readFileSync(path.join(ROOT, "src/scripts/statusline.ts"), "utf8"))
      .toContain("canonicalHookRunId");
  });

  it("keeps semantic fixtures and the provider on canonical Scenario boundaries", () => {
    const fixtureRunner = fs.readFileSync(path.join(ROOT, "src/scenario/fixtures/runner.ts"), "utf8");
    expect(fixtureRunner).toContain("ScenarioRuntime");
    const server = fs.readFileSync(path.join(ROOT, "src/ai-backend/server.ts"), "utf8");
    expect(server).toContain("ScenarioProviderManager");
    expect(sourceFiles("src/scenario/import").map((file) => path.basename(file)))
      .toEqual([]);
  });

  it("evaluates rules from the committed canonical snapshot rather than a host transcript path", () => {
    const executor = fs.readFileSync(path.join(ROOT, "src/effects/rule-pipeline-executor.ts"), "utf8");
    const hostHook = fs.readFileSync(path.join(ROOT, "src/entrypoints/host-hook.ts"), "utf8");
    const nativeTranscript = fs.readFileSync(path.join(ROOT, "src/entrypoints/native-transcript.ts"), "utf8");
    expect(executor).toMatch(/execute\([\s\S]*withCanonicalRuleExecutionContext/);
    expect(executor).toMatch(/executeHookRules[\s\S]*withCanonicalRuleExecutionContext/);
    expect(executor.match(/canonical-transcript\.jsonl/g)).toHaveLength(1);
    expect(executor).toMatch(
      /withCanonicalRuleExecutionContext[\s\S]*canonicalTranscriptFromSnapshot\(snapshot\)/,
    );
    expect(executor).not.toMatch(/hostContext\?\.transcriptPath\s*\?\?/);
    expect(hostHook).not.toMatch(
      /\b(?:readTranscriptExact|readRecentUserMessagesArray|userTurnFollowedByCompletedToolRoundtrip|resolveActiveSlashCommandAllowedTools|detectParallelBatch)\b/,
    );
    expect(hostHook).not.toMatch(/detectPlanModeForHook/);
    expect(nativeTranscript).toMatch(/readTranscriptExactFromEntries/);
    expect(nativeTranscript).toMatch(/detectParallelBatchFromEntries/);
  });

  it("keeps source identity as provenance rather than a runtime policy branch", () => {
    const runtime = contents(sourceFiles("src/scenario/runtime"));
    expect(runtime).not.toMatch(/source\.kind\s*===|switch\s*\([^)]*source\.kind/);
    expect(runtime).not.toMatch(/scenarioMode|externalProviderMode|astralMode/i);
  });

  it("keeps evaluator invocation behind the injected effect adapter", () => {
    const source = contents([
      ...sourceFiles("src/hooks"),
      ...sourceFiles("src/entrypoints"),
      path.join(ROOT, "src/mcp/server.ts"),
    ]);
    expect(source).not.toMatch(/from ["'][^"']*rules\/(?:index|evaluator)\.js["']/);
    expect(source).not.toMatch(/\bevaluateRules(?:ForStop|ForUserPromptSubmit)?\s*\(/);
    const adapter = fs.readFileSync(
      path.join(ROOT, "src/effects/rule-evaluator.ts"),
      "utf8",
    );
    expect(adapter).toContain("evaluateRules(");
    expect(adapter).toContain("evaluateRulesForStop(");
    expect(adapter).toContain("evaluateRulesForUserPromptSubmit(");
  });

  it("keeps the generic runtime independent from Agent Framework composition", () => {
    const runtime = contents(sourceFiles("src/scenario/runtime"));
    const genericCore = contents([
      ...sourceFiles("src/scenario/protocol"),
      ...sourceFiles("src/scenario/runtime"),
      ...sourceFiles("src/scenario/store"),
    ]);
    expect(runtime).not.toMatch(/from ["'][^"']*\/rules\//);
    expect(runtime).not.toMatch(/RulePipelineEffectExecutor|createAgentFrameworkScenarioRuntime|canonicalToolHistory/);
    expect(runtime).not.toMatch(/rulePipeline\.|(?:ToolPolicy|HookRule)Effect|rule-runtime/);
    expect(runtime).not.toMatch(
      /session\.workflow|agent-framework:\/\/state|respondFirst|editIntent|driftState|prediction\.|sentiment\.|statusline\.projection|plan\.mode|gate\.reasoning/,
    );
    expect(fs.readFileSync(path.join(ROOT, "src/scenario/runtime/index.ts"), "utf8"))
      .not.toContain("factory");
    expect(genericCore).not.toMatch(/runtimeRoot|\.agent-framework/);
    expect(genericCore).not.toMatch(
      /hostPreToolUse|hostUserPromptSubmitted|hostStopped|hostSessionStarted|hostPostToolUse|host\.(?:preToolUse|userPromptSubmitted|stopped|sessionStarted|postToolUse)|\b(?:PreToolUse|UserPromptSubmit|SessionStart|PostToolUse)\b|projectHostBoundary/,
    );
    expect(fs.readFileSync(path.join(ROOT, "src/scenario/runtime/runtime.ts"), "utf8"))
      .toMatch(/ScenarioRuntimeOptions\s*=\s*\{[\s\S]*?root:\s*string;/);
  });

  it("keeps the entire reusable Scenario surface free of application composition", () => {
    const scenarioFiles = sourceFiles("src/scenario");
    const scenario = contents(scenarioFiles);
    expect(scenario).not.toMatch(/from ["'][^"']*\/(?:effects|rules)\//);
    expect(scenario).not.toMatch(/from ["'][^"']*\/adapter\//);
    expect(scenario).not.toMatch(
      /\bRule(?:Descriptor|Evaluation)|ruleEvaluation|ruleRegistry|ruleEvaluations|rule\.(?:registry|evaluation|gate|appeal)|adapterSpecByName|canonical-transcript/,
    );
    expect(scenario).not.toMatch(/from ["'][^"']*\/utils\/paths\.js["']/);
    expect(scenario).not.toMatch(
      /createAgentFrameworkScenarioRuntime|RulePipelineEffectExecutor|agentFrameworkEffectPlanner|AGENT_FRAMEWORK_SCENARIO_(?:ROOT|SECRET_PATHS)/,
    );
    const neutralUtilities = new Set([
      "background-errors",
      "cancellation",
      "file-io",
      "filesystem-errors",
      "hash-utils",
      "output",
      "path-containment",
      "resource-lifecycle",
      "temporary-directory",
    ]);
    for (const file of scenarioFiles) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/from ["'][^"']*\/utils\/([^/"']+)\.js["']/g)) {
        expect(neutralUtilities, `${path.relative(ROOT, file)} imports a non-neutral shared utility`)
          .toContain(match[1]);
      }
    }
    const neutralSource = contents([...neutralUtilities].map((name) => path.join(ROOT, `src/utils/${name}.ts`)));
    expect(neutralSource).not.toMatch(/from ["'][^"']*\/(?:providers|effects|rules|agents|ai-backend)\//);
  });

  it("keeps generic fixture and contract tooling independent from Agent Framework composition", () => {
    const fixtures = contents(sourceFiles("src/scenario/fixtures"));
    const contract = fs.readFileSync(path.join(ROOT, "src/scenario/contract-cli.ts"), "utf8");
    for (const generic of [fixtures, contract]) {
      expect(generic).not.toMatch(/from ["'][^"']*\/effects\//);
      expect(generic).not.toMatch(
        /agentFramework|agent-framework\.host|hostPreToolUse|hostUserPromptSubmitted|hostStopped|hostSessionStarted|hostPostToolUse|rulePipeline\./,
      );
    }
    expect(fixtures).toContain("ScenarioFixturePolicy");
  });

  it("derives prediction types and tool observation commands from shared schemas", () => {
    const predictionLogic = fs.readFileSync(
      path.join(ROOT, "src/utils/prediction-types.ts"),
      "utf8",
    );
    const workflow = fs.readFileSync(
      path.join(ROOT, "src/effects/session-workflow.ts"),
      "utf8",
    );
    const commands = fs.readFileSync(
      path.join(ROOT, "src/scenario/protocol/commands.ts"),
      "utf8",
    );
    expect(predictionLogic).not.toMatch(/interface ToolPrediction|interface ToolRequirement/);
    expect(predictionLogic).toContain("prediction-schema.js");
    expect(workflow).toContain("toolPredictionSchema");
    expect(commands).toContain("toolObservationFieldsSchema.extend");
  });

  it("contains no client-specific core protocol or automatic labeler", () => {
    const core = contents([
      ...sourceFiles("src/scenario/protocol"),
      ...sourceFiles("src/runtime-home"),
    ]);
    expect(core).not.toMatch(/managedAstral|ManagedAstral|Astral/);
    expect(fs.readFileSync(path.join(ROOT, "src/agents/mcp/index.ts"), "utf8"))
      .not.toMatch(/scenarioLabeler|ScenarioLabeler/);
  });
});
