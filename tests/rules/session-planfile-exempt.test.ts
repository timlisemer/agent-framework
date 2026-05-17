import * as path from "path";
import { describe, expect, it } from "vitest";
import { editIntentRule } from "../../src/rules/edit-intent.js";
import { predictionBlockRule } from "../../src/rules/prediction-block.js";
import type { RuleContext } from "../../src/rules/types.js";
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
});
