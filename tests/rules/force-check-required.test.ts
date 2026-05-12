import { describe, it, expect } from "vitest";
import { forceCheckRequiredRule } from "../../src/rules/force-check-required.js";
import { sessionStateDefaults } from "../../src/utils/session-store.js";
import type { RuleContext } from "../../src/rules/types.js";

function makeCtx(toolName: string, forceCheckPending = true): RuleContext {
  const state = {
    ...sessionStateDefaults(),
    forceCheckPending,
  };
  return {
    toolName,
    toolInput: {},
    toolUseId: "toolu_force",
    projectDir: "/tmp/project",
    transcriptPath: "/tmp/transcript.jsonl",
    sessionDir: "/tmp/session",
    sessionId: "session",
    state,
    stateManager: {} as RuleContext["stateManager"],
    planMode: false,
    planModeCtx: { active: false, contextString: "" },
  };
}

describe("forceCheckRequiredRule", () => {
  it("does nothing when no check is pending", async () => {
    await expect(forceCheckRequiredRule.check(makeCtx("Bash", false))).resolves.toBeNull();
  });

  it("denies unrelated tools while check is pending (Claude adapter default)", async () => {
    const result = await forceCheckRequiredRule.check(makeCtx("Bash"));
    expect(result).toEqual({
      fastDeny: "Workaround Bash command was denied earlier. You must run agent-framework check MCP (mcp__agent-framework__check) before any other tool.",
    });
  });

  it("allows Claude framework check MCP wire name while pending", async () => {
    await expect(forceCheckRequiredRule.check(makeCtx("mcp__agent-framework__check"))).resolves.toBeNull();
  });

  it("allows Codex framework check MCP wire name while pending (codex adapter)", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      await expect(forceCheckRequiredRule.check(makeCtx("mcp__agent_framework__check"))).resolves.toBeNull();
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_FRAMEWORK_ADAPTER;
      } else {
        process.env.AGENT_FRAMEWORK_ADAPTER = prev;
      }
    }
  });

  it("allows ToolSearch while pending", async () => {
    await expect(forceCheckRequiredRule.check(makeCtx("ToolSearch"))).resolves.toBeNull();
  });
});
