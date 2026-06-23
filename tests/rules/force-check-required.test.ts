import { describe, it, expect } from "vitest";
import { forceCheckRequiredRule } from "../../src/rules/force-check-required.js";
import { sessionStateDefaults } from "../../src/utils/session-store.js";
import { activeSpec } from "../../src/adapter/spec.js";
import { makeRuleContext } from "../helpers/rule-context.js";

function makeCtx(toolName: string, forceCheckPending = true) {
  const state = {
    ...sessionStateDefaults(),
    forceCheckPending,
  };
  return makeRuleContext({
    toolName,
    toolInput: {},
    toolUseId: "toolu_force",
    projectDir: "/tmp/project",
    transcriptPath: "/tmp/transcript.jsonl",
    sessionDir: "/tmp/session",
    sessionId: "session",
    state,
  });
}

describe("forceCheckRequiredRule", () => {
  it("does nothing when no check is pending", async () => {
    await expect(forceCheckRequiredRule.check(makeCtx("Bash", false))).resolves.toBeNull();
  });

  it("denies unrelated tools while check is pending (Claude adapter default)", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "claude";
    try {
      const result = await forceCheckRequiredRule.check(makeCtx("Bash"));
      expect(result).toEqual({
        fastDeny: `Workaround Bash command was denied earlier. You must run ${activeSpec().renderCheckMcpHint()} before any other tool.`,
      });
    } finally {
      if (prev === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
      else process.env.AGENT_FRAMEWORK_ADAPTER = prev;
    }
  });

  it("allows Claude framework check MCP wire name while pending", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "claude";
    try {
      await expect(forceCheckRequiredRule.check(makeCtx(activeSpec().mcpWireName("check")))).resolves.toBeNull();
    } finally {
      if (prev === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
      else process.env.AGENT_FRAMEWORK_ADAPTER = prev;
    }
  });

  it("allows Codex framework check MCP wire name while pending (codex adapter)", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      await expect(forceCheckRequiredRule.check(makeCtx(activeSpec().mcpWireName("check")))).resolves.toBeNull();
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_FRAMEWORK_ADAPTER;
      } else {
        process.env.AGENT_FRAMEWORK_ADAPTER = prev;
      }
    }
  });

  it("allows validate_implementation MCP while pending", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      await expect(forceCheckRequiredRule.check(makeCtx(activeSpec().mcpWireName("validate_implementation")))).resolves.toBeNull();
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_FRAMEWORK_ADAPTER;
      } else {
        process.env.AGENT_FRAMEWORK_ADAPTER = prev;
      }
    }
  });

  it("denies push while pending because push does not run checks", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      const result = await forceCheckRequiredRule.check(makeCtx(activeSpec().mcpWireName("push")));
      expect(result).toEqual({
        fastDeny: `Workaround Bash command was denied earlier. You must run ${activeSpec().renderCheckMcpHint()} before any other tool.`,
      });
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
