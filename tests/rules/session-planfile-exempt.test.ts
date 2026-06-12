import * as path from "path";
import { describe, expect, it } from "vitest";
import { editIntentRule } from "../../src/rules/edit-intent.js";
import { predictionBlockRule } from "../../src/rules/prediction-block.js";
import { planModeBlockRule } from "../../src/rules/plan-mode-block.js";
import type { RuleContext } from "../../src/rules/types.js";
import { getBlacklistHighlights } from "../../src/utils/command-patterns.js";
import { sessionPlanFile } from "../../src/utils/paths.js";

function makeCtx(overrides: Partial<RuleContext>): RuleContext {
  const sessionDir = path.join(process.cwd(), ".tmp-session");
  return {
    hookEvent: "PreToolUse",
    toolName: "Write",
    toolInput: {},
    projectDir: process.cwd(),
    transcriptPath: path.join(sessionDir, "transcript.jsonl"),
    sessionDir,
    sessionId: "session-planfile-exempt",
    state: {
      currentEditIntent: false,
      currentPrediction: null,
      frustrationStreak: 0,
    } as RuleContext["state"],
    stateManager: { update: async () => undefined } as unknown as RuleContext["stateManager"],
    planMode: false,
    planModeCtx: { active: false, contextString: "" },
    ...overrides,
  };
}

describe("session planfile rule exemptions", () => {
  it("edit-intent allows current session planfile writes", async () => {
    const sessionDir = path.join(process.cwd(), ".tmp-session");
    const planPath = sessionPlanFile(sessionDir, "named-plan");
    const result = await editIntentRule.check(makeCtx({
      sessionDir,
      toolInput: { file_path: planPath },
    }));

    expect(result).toBeNull();
  });

  it("prediction-block allows current session planfile writes", async () => {
    const sessionDir = path.join(process.cwd(), ".tmp-session");
    const planPath = sessionPlanFile(sessionDir, "named-plan");
    const result = await predictionBlockRule.check(makeCtx({
      sessionDir,
      toolInput: { file_path: planPath },
      state: {
        currentPrediction: {
          mood: "angry",
          trust: "low",
          intent: "stop",
          blockedIntent: "all tools blocked",
          explicitlyAllowedTools: [],
          explicitlyBlockedSubstrings: [],
          userMessageSnippet: "stop",
          blockAllTools: true,
          timestamp: Date.now(),
        },
        frustrationStreak: 3,
      } as unknown as RuleContext["state"],
    }));

    expect(result).toBeNull();
  });

  it("prediction-block checks mixed planfile and non-exempt writes", async () => {
    const sessionDir = path.join(process.cwd(), ".tmp-session");
    const planPath = sessionPlanFile(sessionDir, "named-plan");
    const result = await predictionBlockRule.check(makeCtx({
      sessionDir,
      toolInput: { file_path: planPath, file_paths: [planPath, "src/main.ts"] },
      state: {
        currentPrediction: {
          mood: "angry",
          trust: "low",
          intent: "stop",
          blockedIntent: "all tools blocked",
          explicitlyAllowedTools: [],
          explicitlyBlockedSubstrings: [],
          userMessageSnippet: "stop",
          blockAllTools: true,
          timestamp: Date.now(),
        },
        frustrationStreak: 3,
      } as unknown as RuleContext["state"],
    }));

    expect(result).toMatchObject({ fastDeny: expect.stringContaining("no tools right now") });
  });

  it("plan-mode-block allows first creation of valid current session planfiles", async () => {
    const sessionDir = path.join(process.cwd(), ".tmp-session");
    const planPath = sessionPlanFile(sessionDir, "shared-ai-ui-runtime");
    const result = await planModeBlockRule.check(makeCtx({
      sessionDir,
      planMode: true,
      planModeCtx: { active: true, contextString: "PLAN MODE ACTIVE" },
      toolName: "Write",
      toolInput: { file_path: planPath, content: "Plan Name: shared-ai-ui-runtime\n" },
    }));

    expect(result).toEqual({
      fastAllow: "Plan mode allows edits to plan files / host instruction files / memory files (path is exempt).",
    });
  });

  it("plan-mode-block still blocks invalid session planfile-like paths", async () => {
    const sessionDir = path.join(process.cwd(), ".tmp-session");
    const invalidPlanPath = path.join(sessionDir, "plans", "Shared AI UI Runtime.md");
    const result = await planModeBlockRule.check(makeCtx({
      sessionDir,
      planMode: true,
      planModeCtx: { active: true, contextString: "PLAN MODE ACTIVE" },
      toolName: "Write",
      toolInput: { file_path: invalidPlanPath, content: "bad" },
    }));

    expect(result).toMatchObject({ fastDeny: expect.stringContaining("Plan mode is active") });
  });

  it("plan-mode-block lets tee writes to session planfiles fall through to blacklist", async () => {
    const sessionDir = path.join(process.cwd(), ".tmp-session");
    const planPath = sessionPlanFile(sessionDir, "shared-ai-ui-runtime");
    const command = `tee ${planPath}`;
    const result = await planModeBlockRule.check(makeCtx({
      sessionDir,
      planMode: true,
      planModeCtx: { active: true, contextString: "PLAN MODE ACTIVE" },
      toolName: "Bash",
      toolInput: { command },
    }));

    expect(result).toBeNull();
    expect(getBlacklistHighlights("Bash", { command }, process.cwd())).toContain("[BLACKLIST: tee file write] Use Write tool");
  });
});
