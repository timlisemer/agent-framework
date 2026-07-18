import * as path from "path";
import { describe, expect, it } from "vitest";
import { editIntentRule } from "../../src/rules/edit-intent.js";
import { predictionBlockRule } from "../../src/rules/prediction-block.js";
import { planModeBlockRule } from "../../src/rules/plan-mode-block.js";
import { ALL_RULES, evaluateRules } from "../../src/rules/index.js";
import type { RuleContext } from "../../src/rules/types.js";
import { getBlacklistHighlights } from "../../src/utils/command-patterns.js";
import { sessionPlanFile } from "../../src/utils/paths.js";
import { sessionStateDefaults } from "../helpers/session-workflow.js";
import { makeRuleContext } from "../helpers/rule-context.js";

function makeCtx(overrides: Partial<RuleContext>): RuleContext {
  const sessionDir = path.join(process.cwd(), ".tmp-session");
  return makeRuleContext({
    hookEvent: "PreToolUse",
    toolName: "Write",
    toolInput: {},
    projectDir: process.cwd(),
    transcriptPath: path.join(sessionDir, "transcript.jsonl"),
    sessionDir,
    sessionId: "session-planfile-exempt",
    state: {
      ...sessionStateDefaults(),
      currentEditIntent: false,
    },
    stateManager: { update: async () => undefined } as unknown as RuleContext["stateManager"],
    ...overrides,
  });
}

describe("session planfile rule exemptions", () => {
  it("plan-mode-block denies create_planfile outside plan mode", async () => {
    const result = await planModeBlockRule.check(makeCtx({
      toolName: "mcp-create_planfile",
      planMode: false,
      planModeCtx: { active: false, contextString: "" },
    }));

    expect(result).toEqual({
      fastDeny: "create_planfile is only available while plan mode is active or required by the current workflow.",
    });
  });

  it("plan-mode-block lets create_planfile continue while plan mode is active", async () => {
    const result = await planModeBlockRule.check(makeCtx({
      toolName: "mcp-create_planfile",
      planMode: true,
      planModeCtx: { active: true, contextString: "PLAN MODE ACTIVE" },
    }));

    expect(result).toBeNull();
  });

  it("full rule chain deterministically allows create_planfile while plan mode is active", async () => {
    const result = await evaluateRules(ALL_RULES, makeCtx({
      toolName: "mcp-create_planfile",
      planMode: true,
      planModeCtx: { active: true, contextString: "PLAN MODE ACTIVE" },
      state: {
        ...sessionStateDefaults(),
        respondFirstChecked: true,
      },
    }), "PreToolUse");

    expect(result).toMatchObject({
      decision: "allow",
      agent: "create-planfile-allow",
      reason: "Plan mode allows create_planfile to write and validate the session planfile.",
      usesLlm: false,
    });
  });

  it("hostile prediction does not mood-deny plan-mode create_planfile before fast-allow", async () => {
    const result = await evaluateRules(ALL_RULES, makeCtx({
      toolName: "mcp-create_planfile",
      planMode: true,
      planModeCtx: { active: true, contextString: "PLAN MODE ACTIVE" },
      state: {
        ...sessionStateDefaults(),
        respondFirstChecked: true,
        currentPrediction: {
          mood: "angry",
          trust: "low",
          intent: "User is upset about the prior workflow attempt.",
          blockedIntent: "",
          explicitlyAllowedTools: [],
          explicitlyBlockedSubstrings: [],
          userMessageSnippet: "this workflow is wrong",
          timestamp: Date.now(),
        },
        frustrationStreak: 3,
      },
    }), "PreToolUse");

    expect(result).toMatchObject({
      decision: "allow",
      agent: "create-planfile-allow",
      reason: "Plan mode allows create_planfile to write and validate the session planfile.",
      usesLlm: false,
    });
  });

  it("stale cached no-tools text does not veto current plan-mode create_planfile authorization", async () => {
    const result = await evaluateRules(ALL_RULES, makeCtx({
      toolName: "mcp-create_planfile",
      latestUserMessage: "continue with the planfile",
      planMode: true,
      planModeCtx: { active: true, contextString: "PLAN MODE ACTIVE" },
      state: {
        ...sessionStateDefaults(),
        respondFirstChecked: true,
        currentPrediction: {
          mood: "angry",
          trust: "low",
          intent: "User previously told the AI to stop all tools.",
          blockedIntent: "",
          explicitlyAllowedTools: [],
          explicitlyBlockedSubstrings: [],
          userMessageFull: "freeze. no tools.",
          userMessageSnippet: "freeze. no tools.",
          blockAllTools: false,
          timestamp: Date.now() - 10_000,
        },
        frustrationStreak: 3,
      },
    }), "PreToolUse");

    expect(result).toMatchObject({
      decision: "allow",
      agent: "create-planfile-allow",
      reason: "Plan mode allows create_planfile to write and validate the session planfile.",
      usesLlm: false,
    });
  });

  it("stale cached blockAllTools does not veto live plan-mode create_planfile authorization", async () => {
    const result = await evaluateRules(ALL_RULES, makeCtx({
      toolName: "mcp-create_planfile",
      latestUserMessage: "continue with the planfile",
      planMode: true,
      planModeCtx: { active: true, contextString: "PLAN MODE ACTIVE" },
      state: {
        ...sessionStateDefaults(),
        respondFirstChecked: true,
        currentPrediction: {
          mood: "angry",
          trust: "low",
          intent: "User previously told the AI to stop all tools.",
          blockedIntent: "No tools.",
          explicitlyAllowedTools: [],
          explicitlyBlockedSubstrings: [],
          userMessageFull: "freeze. no tools.",
          userMessageSnippet: "freeze. no tools.",
          blockAllTools: true,
          timestamp: Date.now() - 10_000,
        },
        frustrationStreak: 3,
      },
    }), "PreToolUse");

    expect(result).toMatchObject({
      decision: "allow",
      agent: "create-planfile-allow",
      reason: "Plan mode allows create_planfile to write and validate the session planfile.",
      usesLlm: false,
    });
  });

  it("full rule chain deterministically allows workflow-required create_planfile outside plan mode", async () => {
    const result = await evaluateRules(ALL_RULES, makeCtx({
      toolName: "mcp-create_planfile",
      toolInput: { continue_workflow: true },
      planMode: false,
      planModeCtx: { active: false, contextString: "" },
      state: {
        ...sessionStateDefaults(),
        respondFirstChecked: true,
        currentPrediction: {
          mood: "neutral",
          trust: "normal",
          intent: "User invoked a plan workflow.",
          blockedIntent: "",
          explicitlyAllowedTools: [],
          explicitlyRequiredTools: [
            { tool: "mcp-create_planfile", input: { continue_workflow: true } },
          ],
          explicitlyBlockedSubstrings: [],
          userMessageSnippet: "/plan3",
          timestamp: Date.now(),
        },
      },
    }), "PreToolUse");

    expect(result).toMatchObject({
      decision: "allow",
      agent: "create-planfile-allow",
      reason: "Workflow requires create_planfile next; planfile creation is authorized.",
      usesLlm: false,
    });
  });

  it("explicit block denies create_planfile before plan-mode fast-allow", async () => {
    const result = await evaluateRules(ALL_RULES, makeCtx({
      toolName: "mcp-create_planfile",
      planMode: true,
      planModeCtx: { active: true, contextString: "PLAN MODE ACTIVE" },
      state: {
        ...sessionStateDefaults(),
        respondFirstChecked: true,
        currentPrediction: {
          mood: "neutral",
          trust: "normal",
          intent: "User does not want a planfile created.",
          blockedIntent: "Do not create a planfile.",
          explicitlyAllowedTools: [],
          explicitlyBlockedSubstrings: [
            { tool: "mcp-create_planfile", reason: "Do not create a planfile." },
          ],
          userMessageSnippet: "do not create a planfile",
          timestamp: Date.now(),
        },
      },
    }), "PreToolUse");

    expect(result).toMatchObject({
      decision: "deny",
      agent: "prediction-block",
    });
    expect(result?.reason).toContain("Do not create a planfile.");
  });

  it("explicit block denies workflow-required create_planfile before fast-allow", async () => {
    const result = await evaluateRules(ALL_RULES, makeCtx({
      toolName: "mcp-create_planfile",
      toolInput: { continue_workflow: true },
      planMode: false,
      planModeCtx: { active: false, contextString: "" },
      state: {
        ...sessionStateDefaults(),
        respondFirstChecked: true,
        currentPrediction: {
          mood: "neutral",
          trust: "normal",
          intent: "User invoked a plan workflow but then blocked planfile creation.",
          blockedIntent: "Do not create a planfile.",
          explicitlyAllowedTools: [],
          explicitlyRequiredTools: [
            { tool: "mcp-create_planfile", input: { continue_workflow: true } },
          ],
          explicitlyBlockedSubstrings: [
            { tool: "mcp-create_planfile", reason: "Do not create a planfile." },
          ],
          userMessageSnippet: "do not create a planfile",
          timestamp: Date.now(),
        },
      },
    }), "PreToolUse");

    expect(result).toMatchObject({
      decision: "deny",
      agent: "prediction-block",
    });
    expect(result?.reason).toContain("Do not create a planfile.");
  });

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
        ...sessionStateDefaults(),
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
      },
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
        ...sessionStateDefaults(),
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
      },
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
