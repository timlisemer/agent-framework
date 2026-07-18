import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { planModeStepContextRule } from "../../src/rules/plan-mode-step-context.js";
import { intentFulfillmentContextRule } from "../../src/rules/intent-fulfillment-context.js";
import { sessionStateDefaults, type ToolLogEntry } from "../helpers/session-workflow.js";
import { makeRuleContext } from "../helpers/rule-context.js";

describe("plan-mode stale workflow intent context", () => {
  let tempDir: string;
  let transcriptPath: string;
  let predictionTimestamp: number;
  let toolHistory: ToolLogEntry[];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mode-step-context-"));
    transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    predictionTimestamp = Date.now() - 10_000;
    toolHistory = [];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function appendToolLog(entry: Partial<ToolLogEntry> & Pick<ToolLogEntry, "tool" | "status">): void {
    toolHistory.push({
      ts: entry.ts ?? Date.now(),
      toolUseId: entry.toolUseId ?? `${entry.tool}-${entry.status}`,
      tool: entry.tool,
      status: entry.status,
      gate: entry.gate ?? "test",
      reason: entry.reason,
      ms: entry.ms ?? 1,
    });
  }

  function makeCtx() {
    return makeRuleContext({
      toolName: "ExitPlanMode",
      toolInput: { plan: "# Consolidated plan" },
      toolUseId: "toolu_scenario_exitplan_after_plan3_firing",
      projectDir: tempDir,
      transcriptPath,
      sessionDir: tempDir,
      sessionId: "scenario",
      planMode: true,
      planModeCtx: { active: true, contextString: "PLAN MODE ACTIVE" },
      state: {
        ...sessionStateDefaults(),
        currentPrediction: {
          mood: "neutral",
          trust: "normal",
          intent: "User demands the AI load/read /plan3 skill and execute the prior request to start 3 validation agents per /plan3.",
          blockedIntent: "",
          explicitlyAllowedTools: [],
          explicitlyBlockedSubstrings: [],
          userMessageSnippet: "fuck you first 30 sentence apology then read it and do what i want",
          blockAllTools: false,
          timestamp: predictionTimestamp,
        },
        frustrationStreak: 4,
        currentWindowSize: 4,
      },
      toolHistory,
    });
  }

  it("contributes fulfillment and plan-step context after the cached plan3 validator intent has been served", async () => {
    appendToolLog({
      ts: predictionTimestamp - 1_000,
      tool: "Skill",
      status: "denied",
      gate: "prediction-block",
      reason: "User appears angry. Blocking Skill unless explicitly requested.",
    });
    appendToolLog({ ts: predictionTimestamp + 1_000, tool: "Agent", status: "allowed" });
    appendToolLog({ ts: predictionTimestamp + 2_000, tool: "Agent", status: "allowed" });
    appendToolLog({ ts: predictionTimestamp + 3_000, tool: "Agent", status: "allowed" });
    appendToolLog({
      ts: predictionTimestamp + 4_000,
      tool: "ExitPlanMode",
      status: "denied",
      gate: "plan-validate",
      reason: "Plan validation failed: ellipsis in inline code",
    });

    const ctx = makeCtx();

    const fulfillment = await intentFulfillmentContextRule.check(ctx);
    expect(fulfillment).toHaveProperty("llmContext");
    expect((fulfillment as { llmContext: string }).llmContext).toContain("INTENT FULFILLMENT");
    expect((fulfillment as { llmContext: string }).llmContext).toContain("validator/validation agents");

    const stepContext = await planModeStepContextRule.check(ctx);
    expect(stepContext).toHaveProperty("llmContext");
    expect((stepContext as { llmContext: string }).llmContext).toContain("PLAN MODE STEP AWARENESS");
    expect((stepContext as { llmContext: string }).llmContext).toContain("ExitPlanMode is the prescribed terminal step");
  });

  it("does not contribute plan-step context before any matching post-prediction agent work exists", async () => {
    appendToolLog({
      ts: predictionTimestamp - 1_000,
      tool: "Agent",
      status: "allowed",
    });

    await expect(intentFulfillmentContextRule.check(makeCtx())).resolves.toBeNull();
    await expect(planModeStepContextRule.check(makeCtx())).resolves.toBeNull();
  });
});
