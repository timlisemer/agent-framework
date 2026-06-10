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

async function appealPatchAlias(
  message: string,
  paths: string[] = ["src/a.ts"],
): Promise<{ overturned: boolean; gateNote?: string }> {
  return appealHelper(
    "Edit",
    `ApplyPatch(file_paths=${JSON.stringify(paths)})`,
    "",
    "The old_string and new_string parameters are non-string values.",
    "/tmp",
    "PreToolUse",
    userState(message),
    undefined,
    undefined,
    { rawToolName: "apply_patch", canonicalToolName: "Edit", rawToolNameIsAppealAlias: true },
  );
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

  it("lets the appeal LLM overturn when the user authorizes a raw adapter tool alias", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "tool-appeal": "OVERTURN: APPROVE" });

    const appeal = await appealPatchAlias("I explicitly allow you to use apply_patch however you want.");

    expect(appeal.overturned).toBe(true);
  });

  it("does not deterministically overturn from the canonical alias alone", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "tool-appeal": "UPHOLD" });

    const appeal = await appealPatchAlias("I explicitly allow Edit for src/a.ts.");

    expect(appeal.overturned).toBe(false);
  });

  it("does not deterministically overturn broad raw aliases without adapter authorization", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "tool-appeal": "UPHOLD" });

    const appeal = await appealHelper(
      "Bash",
      summarizeToolInputForLlm("Bash", { command: "npm test" }),
      "",
      "Bash command denied.",
      "/tmp",
      "PreToolUse",
      userState("Use exec_command for this."),
      undefined,
      undefined,
      { rawToolName: "exec_command", canonicalToolName: "Bash", rawToolNameIsAppealAlias: false },
    );

    expect(appeal.overturned).toBe(false);
  });

  it("does not treat quoted raw alias mentions as authorization", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "tool-appeal": "UPHOLD" });

    const appeal = await appealPatchAlias("why did this happen? QUOTE: use apply_patch QUOTE END");

    expect(appeal.overturned).toBe(false);
  });

  it("does not treat negated raw alias mentions as authorization", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "tool-appeal": "UPHOLD" });

    const appeal = await appealPatchAlias("do not use apply_patch here");

    expect(appeal.overturned).toBe(false);
  });

  it.each([
    "why did apply_patch fail?",
    "is apply_patch the right tool?",
    "would Edit help here?",
    "what does apply_patch do?",
  ])("does not treat non-authorizing alias discussion as authorization: %s", async (message) => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "tool-appeal": "UPHOLD" });

    const appeal = await appealPatchAlias(message);

    expect(appeal.overturned).toBe(false);
  });

  it("does not deterministically overturn a raw alias mention without the target path", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "tool-appeal": "UPHOLD" });

    const appeal = await appealPatchAlias("I explicitly allow apply_patch for this.");

    expect(appeal.overturned).toBe(false);
  });

  it("does not deterministically overturn when the user authorizes a different target path", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "tool-appeal": "UPHOLD" });

    const appeal = await appealPatchAlias("I explicitly allow apply_patch on src/a.ts.", ["src/b.ts"]);

    expect(appeal.overturned).toBe(false);
  });

  it.each([
    ["inline backticks", "the previous error said `use apply_patch`"],
    ["fenced code", "here is the old instruction:\n```\nuse apply_patch\n```"],
    ["CLI marker", "tool output:\n⎿ use apply_patch\n  more output"],
    ["blockquote", "> use apply_patch\nwhat happened here?"],
    ["inline double quote", 'the log says "use apply_patch" but why?'],
  ])("does not treat %s raw alias mentions as authorization", async (_name, message) => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "tool-appeal": "UPHOLD" });

    const appeal = await appealPatchAlias(message);

    expect(appeal.overturned).toBe(false);
  });
});
