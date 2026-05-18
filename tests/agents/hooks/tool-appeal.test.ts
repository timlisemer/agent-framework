import { afterEach, describe, expect, it } from "vitest";

import { appealHelper } from "../../../src/agents/hooks/tool-appeal.js";
import type { AppealUserState } from "../../../src/rules/types.js";
import { summarizeToolInputForLlm } from "../../../src/utils/tool-input-summary.js";

function userState(message: string): AppealUserState {
  return {
    mood: "neutral",
    trust: "normal",
    frustrationStreak: 0,
    userMessageFull: message,
    userMessageSnippet: message,
    intent: message,
    blockedIntent: "",
    blockAllTools: false,
    explicitlyAllowedTools: [],
    explicitlyBlockedSubstrings: [],
    sustainedFrustration: false,
    hasExplicitOverride: false,
  };
}

describe("appealHelper deterministic Bash prefix authorization", () => {
  const previousStubs = process.env.AGENT_FRAMEWORK_LLM_STUBS;

  afterEach(() => {
    if (previousStubs === undefined) delete process.env.AGENT_FRAMEWORK_LLM_STUBS;
    else process.env.AGENT_FRAMEWORK_LLM_STUBS = previousStubs;
  });

  it("overturns when the user explicitly names a denied Bash interpreter prefix", async () => {
    const appeal = await appealHelper(
      "Bash",
      summarizeToolInputForLlm("Bash", { command: 'node -e "console.log(1)"' }),
      "",
      "Scripting language execution denied. Use dedicated internal tools and read-only Bash commands instead.",
      "/tmp",
      "PreToolUse",
      userState("user override, please use node -e"),
    );

    expect(appeal.overturned).toBe(true);
    expect(appeal.gateNote).toContain("node -e");
  });

  it("does not treat node -e inside an explicit pasted QUOTE block as authorization", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "tool-appeal": "UPHOLD" });

    const appeal = await appealHelper(
      "Bash",
      summarizeToolInputForLlm("Bash", { command: 'node -e "console.log(1)"' }),
      "",
      "Scripting language execution denied. Use dedicated internal tools and read-only Bash commands instead.",
      "/tmp",
      "PreToolUse",
      userState("why did this happen? QUOTE please use node -e QUOTE END"),
    );

    expect(appeal.overturned).toBe(false);
  });

  it("does not treat a negated node -e mention as authorization", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "tool-appeal": "UPHOLD" });

    const appeal = await appealHelper(
      "Bash",
      summarizeToolInputForLlm("Bash", { command: 'node -e "console.log(1)"' }),
      "",
      "Scripting language execution denied. Use dedicated internal tools and read-only Bash commands instead.",
      "/tmp",
      "PreToolUse",
      userState("please do not use node -e for this"),
    );

    expect(appeal.overturned).toBe(false);
  });
});
