import { ScenarioProviderManager } from "../../src/ai-backend/scenario-provider-manager.js";
import type { ProviderRunner } from "../../src/ai-backend/provider.js";
import { createTestScenarioRuntime } from "./scenario-runtime.js";
import { testResolvedProvider } from "./scenario-fixtures.js";

const root = process.argv[2];
if (!root) throw new Error("provider shutdown child requires a run root");

const runtime = createTestScenarioRuntime({ root });
let markTurnEntered!: () => void;
const turnEntered = new Promise<void>((resolve) => { markTurnEntered = resolve; });
const neverSettles = new Promise<void>(() => {});
const manager = new ScenarioProviderManager({
  runtime,
  providerSettlementTimeoutMs: 25,
  resolveProvider: () => testResolvedProvider({ sdkRuntime: "claude" }),
  createRunner: (resolvedProvider): ProviderRunner => ({
    resolvedProvider,
    async *runTurn() {
      markTurnEntered();
      await neverSettles;
    },
    dispose: () => neverSettles,
  }),
});

const { runId } = await manager.host.start({
  model: null,
  workingDir: root,
  systemPrompt: null,
  continuable: true,
  sdkRuntimeEnvironment: "isolated",
  runtimeHome: { kind: "native", configuration: {} },
});
await manager.host.send(runId, "shutdown-turn", "never settle");
await turnEntered;
await manager.dispose();
const snapshot = await runtime.snapshot(runId);
const diagnostic = "Provider cleanup timed out while tearing down the provider run; provider detached";
if (snapshot.status !== "cancelled" || !snapshot.recoveryDiagnostics.includes(diagnostic)) {
  throw new Error("provider shutdown did not terminalize the run and persist its timeout diagnostic");
}
process.stdout.write(`${JSON.stringify({ status: snapshot.status, diagnostic })}\n`);
