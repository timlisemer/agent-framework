import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  advanceRequiredToolsAfterAllowedToolSequence,
  decidePrediction,
  decideRequiredWorkflowToolSequence,
  deriveWorkflowToolRequirementsFromText,
  toolRequirementMatches,
  toolCapabilityMatchesRequirement,
  uniqueToolRequirements,
  type ToolPrediction,
  type ToolRequirement,
} from "../../src/utils/prediction-types.js";
import type { CanonicalWorkflow, HostContext } from "../../src/adapter/types.js";
import { activeSpec } from "../../src/adapter/spec.js";
import { claudeSpec } from "../../adapters/claude/index.js";
import { codexSpec } from "../../adapters/codex/index.js";
import {
  codexPlan3InitialAgentBatchRequirements,
  implementWorkflowRequirementSignatures,
  repeatReq,
  req,
  requirementSignature,
  waitReq,
  type RequirementSignature,
} from "../helpers/workflow-requirements.js";
import {
  bashExpansionReadProofCases,
  bashDoesNotReadRequiredPathCommands,
  bashNoReadCapabilityCommands,
  bashReadCapabilityCommands,
  unsafeBashReadCommands,
} from "../helpers/bash-read-fixtures.js";

function makePrediction(required: ToolRequirement[]): ToolPrediction {
  const { nonBlockingTools } = deriveWorkflowToolRequirementsFromText("Call `mcp-check`.");
  return {
    mood: "angry",
    trust: "low",
    intent: "workflow test",
    blockedIntent: "",
    explicitlyAllowedTools: ["Agent", "TaskOutput", "mcp-create_planfile"],
    explicitlyRequiredTools: required,
    nonBlockingTools,
    explicitlyBlockedSubstrings: [],
    userMessageSnippet: "workflow test",
    timestamp: Date.now(),
  };
}

describe("canonical tool capabilities", () => {
  it("matches any capability with the same generic requirement rules", () => {
    const capability = {
      tool: "Grep",
      input: { pattern: "needle", path: "src", matches: [1, 2] },
    };

    expect(toolCapabilityMatchesRequirement(
      { tool: "Grep", input: { pattern: "needle", path: "src" } },
      capability,
    )).toBe(true);
    expect(toolCapabilityMatchesRequirement(
      { tool: "Grep", inputArrayLengths: { matches: 2 } },
      capability,
    )).toBe(true);
    expect(toolCapabilityMatchesRequirement(
      { tool: "Grep", input: { pattern: "other" } },
      capability,
    )).toBe(false);
    expect(toolCapabilityMatchesRequirement(
      { tool: "Read", input: { file_path: "src" } },
      capability,
    )).toBe(false);
  });
});

const COMMON_WORKFLOW_EXPECTATIONS: Record<string, RequirementSignature[]> = {
  check: [req("mcp-check", undefined, undefined, ["working_dir"])],
  commit: [req("mcp-commit", undefined, undefined, ["working_dir"])],
  confirm: [req("mcp-confirm", undefined, undefined, ["working_dir"])],
  fullconfirm: [req("mcp-fullconfirm", undefined, undefined, ["working_dir"])],
  fullquickconfirm: [req("mcp-fullconfirm", { model_tier: "haiku", skip_elicitation: true })],
  implement: implementWorkflowRequirementSignatures(),
  "locate-scenario": [req("mcp-locate_scenario")],
  push: [req("mcp-commit", { auto_push: true })],
  quickconfirm: [req("mcp-confirm", { model_tier: "haiku", skip_elicitation: true })],
  quickpush: [req("mcp-commit", { model_tier: "haiku", skip_elicitation: true, auto_push: true })],
  transcript: [req("mcp-transcript")],
  validate: [req("mcp-validate_implementation", undefined, undefined, ["working_dir"])],
  "validate-plan": [req("mcp-validate_plan", undefined, undefined, ["working_dir"])],
};

const CODEX_PLAN_EXPECTATIONS: Record<string, RequirementSignature[]> = {
  plan1: [
    req("Agent", { subagent_type: "default" }),
    waitReq(1),
    req("mcp-create_planfile"),
    req("Agent", { subagent_type: "default" }),
    waitReq(1),
  ],
  plan3: [
    ...codexPlan3InitialAgentBatchRequirements(),
    req("mcp-create_planfile"),
    ...codexPlan3InitialAgentBatchRequirements(),
  ],
  plan5: [
    ...repeatReq(5, "Agent", { subagent_type: "default" }),
    waitReq(5),
    req("mcp-create_planfile"),
    ...repeatReq(5, "Agent", { subagent_type: "default" }),
    waitReq(5),
  ],
};

const CLAUDE_PLAN_EXPECTATIONS: Record<string, RequirementSignature[]> = {
  plan1: [
    req("Agent", { subagent_type: "Plan" }),
    req("mcp-create_planfile", { continue_workflow: true }),
    req("Agent", { subagent_type: "Plan" }),
    req("ExitPlanMode"),
  ],
  plan3: [
    ...repeatReq(3, "Agent", { subagent_type: "Plan" }),
    req("mcp-create_planfile", { continue_workflow: true }),
    ...repeatReq(3, "Agent", { subagent_type: "Plan" }),
    req("ExitPlanMode"),
  ],
  plan5: [
    ...repeatReq(5, "Agent", { subagent_type: "Plan" }),
    req("mcp-create_planfile", { continue_workflow: true }),
    ...repeatReq(5, "Agent", { subagent_type: "Plan" }),
    req("ExitPlanMode"),
  ],
};

function mapWorkflowExpectations(
  expectations: Record<string, RequirementSignature[]>,
  pathForWorkflow: (workflow: string) => string,
): Record<string, RequirementSignature[]> {
  return Object.fromEntries(
    Object.entries(expectations).map(([workflow, expected]) => [
      pathForWorkflow(workflow),
      expected,
    ]),
  );
}

const CODEX_SKILL_EXPECTATIONS = mapWorkflowExpectations(
  {
    ...COMMON_WORKFLOW_EXPECTATIONS,
    ...CODEX_PLAN_EXPECTATIONS,
  },
  (workflow) => `adapters/codex/dotcodex/skills/agent-framework-${workflow}/SKILL.md`,
);

const CLAUDE_COMMAND_EXPECTATIONS = mapWorkflowExpectations(
  {
    ...COMMON_WORKFLOW_EXPECTATIONS,
    ...CLAUDE_PLAN_EXPECTATIONS,
  },
  (workflow) => `adapters/claude/dotclaude/commands/${workflow}.md`,
);

function testHost(adapter: "claude" | "codex"): HostContext {
  return {
    adapter,
    projectDir: process.cwd(),
    configRoot: path.join(process.cwd(), ".missing-host-config"),
    plansRoot: path.join(process.cwd(), ".missing-host-config", "plans"),
    instructionFiles: [],
    instructionLabel: "test",
  };
}

function workflowFromCodexSkillPath(file: string): CanonicalWorkflow {
  const match = /agent-framework-([^/]+)\/SKILL\.md$/.exec(file);
  if (!match) throw new Error(`Unexpected Codex skill path: ${file}`);
  return match[1] as CanonicalWorkflow;
}

function workflowFromClaudeCommandPath(file: string): CanonicalWorkflow {
  const match = /commands\/([^/]+)\.md$/.exec(file);
  if (!match) throw new Error(`Unexpected Claude command path: ${file}`);
  return match[1] as CanonicalWorkflow;
}

function codexWorkflowInstructionText(workflow: CanonicalWorkflow): string {
  const text = codexSpec.workflowInstructionText(workflow, testHost("codex"));
  expect(text).not.toBeNull();
  return text ?? "";
}

function claudeWorkflowInstructionText(workflow: CanonicalWorkflow): string {
  const text = claudeSpec.workflowInstructionText(workflow, testHost("claude"));
  expect(text).not.toBeNull();
  return text ?? "";
}

describe("workflow prediction extraction from adapter-canonicalized instruction text", () => {
  it("has expectations for every Codex skill file", () => {
    const skillRoot = path.join(process.cwd(), "adapters/codex/dotcodex/skills");
    const actual = fs.readdirSync(skillRoot)
      .map((name) => `adapters/codex/dotcodex/skills/${name}/SKILL.md`)
      .filter((file) => fs.existsSync(path.join(process.cwd(), file)))
      .sort();

    expect(Object.keys(CODEX_SKILL_EXPECTATIONS).sort()).toEqual(actual);
  });

  for (const [file, expected] of Object.entries(CODEX_SKILL_EXPECTATIONS)) {
    it(`derives ordered requirements for ${file}`, () => {
      const derived = deriveWorkflowToolRequirementsFromText(
        codexWorkflowInstructionText(workflowFromCodexSkillPath(file)),
      );

      expect(derived.explicitlyRequiredTools.map(requirementSignature)).toEqual(expected);
      expect(derived.nonBlockingTools.map(requirementSignature)).toContainEqual(req("Read"));
      expect(derived.nonBlockingTools.map(requirementSignature)).toContainEqual(req("Skill"));
      expect(derived.nonBlockingTools.map(requirementSignature)).toContainEqual(req("CloseAgent"));
      expect(derived.nonBlockingTools.map(requirementSignature)).not.toContainEqual(req("TaskOutput"));
    });
  }

  it("has expectations for every Claude command file", () => {
    const commandRoot = path.join(process.cwd(), "adapters/claude/dotclaude/commands");
    const actual = fs.readdirSync(commandRoot)
      .map((name) => `adapters/claude/dotclaude/commands/${name}`)
      .filter((file) => fs.existsSync(path.join(process.cwd(), file)))
      .sort();

    expect(Object.keys(CLAUDE_COMMAND_EXPECTATIONS).sort()).toEqual(actual);
  });

  for (const [file, expected] of Object.entries(CLAUDE_COMMAND_EXPECTATIONS)) {
    it(`derives canonical requirements from non-Codex command text ${file}`, () => {
      const derived = deriveWorkflowToolRequirementsFromText(
        claudeWorkflowInstructionText(workflowFromClaudeCommandPath(file)),
      );

      expect(derived.explicitlyRequiredTools.map(requirementSignature)).toEqual(expected);
    });
  }

  it("ignores negative and conditional Agent or ExitPlanMode instructions", () => {
    const derived = deriveWorkflowToolRequirementsFromText(`
Do not Call ExitPlanMode.
Don't Spawn exactly three \`default\` agents.
Do not Launch exactly 1 Agent tool call with \`subagent_type: "default"\`.
Do not Call the Agent tool once with subagent_type "default".
Do not Agent call 1: subagent_type "default".
Do not call the Agent tool exactly two times with subagent_type "default".
If ready, Call ExitPlanMode.
Retry Spawn exactly two \`default\` agents.
Call ExitPlanMode.
Spawn exactly one \`default\` agent.
`);

    expect(derived.explicitlyRequiredTools.map(requirementSignature)).toEqual([
      req("ExitPlanMode"),
      req("Agent", { subagent_type: "default" }),
    ]);
  });

  it("keeps implement workflow on the MCP-owned path", () => {
    const { explicitlyRequiredTools } = deriveWorkflowToolRequirementsFromText(
      codexWorkflowInstructionText("implement"),
    );
    const prediction = makePrediction(explicitlyRequiredTools);

    expect(explicitlyRequiredTools.map(requirementSignature)).toEqual([
      ...implementWorkflowRequirementSignatures(),
    ]);
    expect(decidePrediction(prediction, "Agent", { subagent_type: "implementer" }, 5).decision).toBe("deny");
    expect(decidePrediction(prediction, "mcp-implement", { planfile: "/repo/plan.md" }, 5).decision).toBe("deny");
    expect(decidePrediction(prediction, "mcp-implement", { working_dir: "/repo", planfile: "/repo/plan.md" }, 5).decision).toBe("allow");
    expect(advanceRequiredToolsAfterAllowedToolSequence(
      prediction,
      [{ toolName: "mcp-implement", toolInput: { working_dir: "/repo", planfile: "/repo/plan.md" } }],
    ).explicitlyRequiredTools?.map(requirementSignature)).toEqual([]);
  });

  it("validates all members of a strict parallel Agent batch before advancing", () => {
    const { explicitlyRequiredTools } = deriveWorkflowToolRequirementsFromText(
      codexWorkflowInstructionText("plan3"),
    );
    const prediction = makePrediction(explicitlyRequiredTools);
    const validBatch = [
      { toolName: "Agent", toolInput: { subagent_type: "default" } },
      { toolName: "Agent", toolInput: { subagent_type: "default" } },
      { toolName: "Agent", toolInput: { subagent_type: "default" } },
    ];

    expect(decideRequiredWorkflowToolSequence(prediction, validBatch).decision).toBe("allow");
    expect(advanceRequiredToolsAfterAllowedToolSequence(
      prediction,
      validBatch,
    ).explicitlyRequiredTools?.map(requirementSignature)).toEqual([
      waitReq(3),
      req("mcp-create_planfile"),
      ...codexPlan3InitialAgentBatchRequirements(),
    ]);

    const wrongType = [
      validBatch[0],
      { toolName: "Agent", toolInput: { subagent_type: "implementer" } },
      validBatch[2],
    ];
    const wrongDecision = decideRequiredWorkflowToolSequence(prediction, wrongType);
    expect(wrongDecision.decision).toBe("deny");
    expect(wrongDecision.reason).toContain("subagent_type=\"default\"");

    const overLaunch = [...validBatch, { toolName: "Agent", toolInput: { subagent_type: "default" } }];
    const overLaunchDecision = decideRequiredWorkflowToolSequence(prediction, overLaunch);
    expect(overLaunchDecision.decision).toBe("deny");
    expect(overLaunchDecision.reason).toContain("TaskOutput");
  });

  it("allows low-risk support tools as non-blocking without letting TaskOutput bypass ordered waits", () => {
    const prediction = makePrediction([
      { tool: "Agent", input: { subagent_type: "implementer" } },
    ]);

    expect(prediction.nonBlockingTools?.map(requirementSignature)).toContainEqual(req("TodoWrite"));
    expect(prediction.nonBlockingTools?.map(requirementSignature)).not.toContainEqual(req("TaskOutput"));
    expect(prediction.nonBlockingTools?.map(requirementSignature)).not.toContainEqual(req("Wait"));
    expect(decidePrediction(
      prediction,
      "TodoWrite",
      { todos: [] },
      0,
    ).decision).toBe("allow");
    expect(decidePrediction(
      prediction,
      "TaskOutput",
      { targets: ["agent-1"] },
      0,
    ).decision).toBe("deny");
  });

  it("allows MCP description discovery even when the prediction omitted non-blocking tools", () => {
    const prediction = {
      ...makePrediction([{ tool: "mcp-check" }]),
      nonBlockingTools: [],
    };

    for (const tool of ["ToolSearch", "ListMcpResources", "ReadMcpResource"]) {
      expect(decidePrediction(prediction, tool, {}, 0).decision).toBe("allow");
    }
    expect(decidePrediction(prediction, "Read", { file_path: "README.md" }, 0).decision)
      .toBe("deny");
  });

  it("strictly recognizes full MCP names without suffix collisions", () => {
    const fullconfirmWire = activeSpec().mcpWireName("fullconfirm");
    const prediction = makePrediction([{ tool: "mcp-fullconfirm" }]);

    expect(decidePrediction(prediction, fullconfirmWire, {}, 0).decision).toBe("allow");
    expect(decidePrediction(
      prediction,
      fullconfirmWire.replace(/fullconfirm$/, "notcheck"),
      {},
      0,
    ).decision).toBe("deny");
    expect(deriveWorkflowToolRequirementsFromText("Call `mcp-notcheck`.")
      .explicitlyRequiredTools).toEqual([]);
  });

  it("deduplicates MCP discovery support by requirement identity", () => {
    const prediction = makePrediction([{ tool: "mcp-check" }]);
    for (const tool of ["ToolSearch", "ListMcpResources", "ReadMcpResource"]) {
      const matches = uniqueToolRequirements([
        ...(prediction.nonBlockingTools ?? []),
        { tool, reason: "duplicate discovery reason" },
      ]).filter((requirement) => requirement.tool === tool);
      expect(matches).toHaveLength(1);
    }
  });

  it("deduplicates equivalent inputs independent of key insertion order", () => {
    const first: ToolRequirement = {
      tool: "mcp-commit",
      input: { auto_push: true, skip_elicitation: true },
      reason: "first",
    };
    const second: ToolRequirement = {
      tool: "mcp-commit",
      input: { skip_elicitation: true, auto_push: true },
      reason: "second",
    };

    expect(uniqueToolRequirements([first, second])).toEqual([first]);
  });

  it("matches Codex raw spawn_agent input only after adapter canonicalization normalizes agent_type", () => {
    const requirement = req("Agent", { subagent_type: "implementer" }) as ToolRequirement;
    const canonical = codexSpec.canonicalizeToolCall("spawn_agent", {
      agent_type: "implementer",
      message: "implement the plan",
    });

    expect(canonical.toolName).toBe("Agent");
    expect(canonical.toolInput).toMatchObject({ subagent_type: "implementer" });
    expect(toolRequirementMatches(requirement, canonical.toolName, canonical.toolInput)).toBe(true);

    const wrong = codexSpec.canonicalizeToolCall("spawn_agent", {
      agent_type: "default",
      message: "implement the plan",
    });
    expect(toolRequirementMatches(requirement, wrong.toolName, wrong.toolInput)).toBe(false);

    const implicitDefault = codexSpec.canonicalizeToolCall("spawn_agent", {
      message: "plan the task",
    });
    expect(implicitDefault.toolInput).toMatchObject({ subagent_type: "default" });
    expect(toolRequirementMatches(
      req("Agent", { subagent_type: "default" }) as ToolRequirement,
      implicitDefault.toolName,
      implicitDefault.toolInput,
    ))
      .toBe(true);
  });

  it("normalizes raw Codex requirement names through adapter canonicalization", () => {
    const rawRequirement: ToolRequirement = { tool: "exec_command" };
    const prediction = makePrediction([rawRequirement]);
    const observed = codexSpec.canonicalizeToolCall("exec_command", {
      command: "pwd",
    });

    expect(observed.toolName).toBe("Bash");
    expect(decidePrediction(
      prediction,
      observed.toolName,
      observed.toolInput,
      0,
    ).decision).toBe("allow");
    expect(advanceRequiredToolsAfterAllowedToolSequence(
      prediction,
      [observed],
    ).explicitlyRequiredTools).toEqual([]);
    expect(uniqueToolRequirements([rawRequirement])).toEqual([{ tool: "Bash" }]);

    for (const { raw, canonical } of [
      { raw: "apply_patch", canonical: "Edit" },
      { raw: "spawn_agent", canonical: "Agent" },
      { raw: "wait_agent", canonical: "TaskOutput" },
      { raw: "tool_search", canonical: "ToolSearch" },
      { raw: "list_mcp_resources", canonical: "ListMcpResources" },
      { raw: "read_mcp_resource", canonical: "ReadMcpResource" },
      { raw: "wait", canonical: "Wait" },
    ]) {
      expect(uniqueToolRequirements([{ tool: raw }])).toEqual([{ tool: canonical }]);
    }
  });

  it("canonicalizes Codex wait and close lifecycle tools for workflow matching", () => {
    expect(codexSpec.canonicalizeToolCall("wait", { cell_id: "cell-1" })).toEqual({
      toolName: "Wait",
      toolInput: { cell_id: "cell-1" },
    });

    const waitMany = codexSpec.canonicalizeToolCall("wait_agent", { targets: ["agent-1"] });
    expect(waitMany.toolName).toBe("TaskOutput");
    expect(waitMany.toolInput).toMatchObject({ targets: ["agent-1"] });

    const waitOne = codexSpec.canonicalizeToolCall("wait_agent", { target: "agent-2" });
    expect(waitOne.toolName).toBe("TaskOutput");
    expect(waitOne.toolInput).toMatchObject({ targets: ["agent-2"] });

    expect(codexSpec.canonicalizeToolCall("close_agent", { target: "agent-1" }).toolName)
      .toBe("CloseAgent");
  });

  it("canonicalizes Codex support tools for non-blocking workflow matching", () => {
    const prediction = makePrediction([
      { tool: "Agent", input: { subagent_type: "default" } },
    ]);
    const cases = [
      { raw: "tool_search", canonical: "ToolSearch", input: { query: "agent-framework" } },
      { raw: "list_mcp_resources", canonical: "ListMcpResources", input: {} },
      { raw: "read_mcp_resource", canonical: "ReadMcpResource", input: { uri: "file:///tmp/a" } },
    ];

    for (const { raw, canonical, input } of cases) {
      const call = codexSpec.canonicalizeToolCall(raw, input);

      expect(call.toolName).toBe(canonical);
      expect(toolRequirementMatches(
        req(canonical) as ToolRequirement,
        call.toolName,
        call.toolInput,
      )).toBe(true);
      expect(decidePrediction(
        prediction,
        call.toolName,
        call.toolInput,
        0,
      ).decision).toBe("allow");
    }
  });

  it("matches canonical Read against each adapter's native file-reading surface", () => {
    const planfile = "/tmp/agent-framework/plans/read-tool-surface.md";
    const requirement: ToolRequirement = {
      tool: "Read",
      input: { file_path: planfile },
    };

    const claudeRead = claudeSpec.canonicalizeToolCall("Read", { file_path: planfile });
    expect(toolRequirementMatches(
      requirement,
      claudeRead.toolName,
      claudeRead.toolInput,
    )).toBe(true);

    const codexRead = codexSpec.canonicalizeToolCall("exec_command", {
      command: `sed -n '1,240p' '${planfile}'`,
    });
    expect(codexRead.toolName).toBe("Bash");
    expect(toolRequirementMatches(
      requirement,
      codexRead.toolName,
      codexRead.toolInput,
    )).toBe(true);
    expect(toolRequirementMatches(
      { tool: "Read", input: { path: planfile } },
      codexRead.toolName,
      codexRead.toolInput,
    )).toBe(true);
    expect(toolRequirementMatches(
      { tool: "Read", input: { file_path: planfile, offset: 10 } },
      codexRead.toolName,
      codexRead.toolInput,
    )).toBe(false);

    for (const command of [
      ...bashNoReadCapabilityCommands(planfile),
      ...bashDoesNotReadRequiredPathCommands(planfile),
      ...unsafeBashReadCommands(planfile),
    ]) {
      const call = codexSpec.canonicalizeToolCall("exec_command", { command });
      expect(toolRequirementMatches(
        requirement,
        call.toolName,
        call.toolInput,
      ), command).toBe(false);
    }

    for (const command of bashReadCapabilityCommands(planfile)) {
      const call = codexSpec.canonicalizeToolCall("exec_command", { command });
      expect(toolRequirementMatches(
        requirement,
        call.toolName,
        call.toolInput,
      ), command).toBe(true);
    }

    const attachedRedirect = codexSpec.canonicalizeToolCall("exec_command", {
      command: `cat '${planfile}'>/dev/stdout`,
    });
    expect(toolRequirementMatches(
      { tool: "Read", input: { file_path: `${planfile}>/dev/stdout` } },
      attachedRedirect.toolName,
      attachedRedirect.toolInput,
    )).toBe(false);
    const attachedInputRedirect = codexSpec.canonicalizeToolCall("exec_command", {
      command: `cat <'${planfile}'`,
    });
    expect(toolRequirementMatches(
      { tool: "Read", input: { file_path: `<${planfile}` } },
      attachedInputRedirect.toolName,
      attachedInputRedirect.toolInput,
    )).toBe(false);

    const spacedPlanfile = "/tmp/agent-framework/plans/read tool surface.md";
    const spacedRead = codexSpec.canonicalizeToolCall("exec_command", {
      command: `cat '${spacedPlanfile}'`,
    });
    expect(toolRequirementMatches(
      { tool: "Read", input: { file_path: spacedPlanfile } },
      spacedRead.toolName,
      spacedRead.toolInput,
    )).toBe(true);

    const structuredSpacedRead = codexSpec.canonicalizeToolCall("exec_command", {
      command: "cat",
      args: [spacedPlanfile],
    });
    expect(toolRequirementMatches(
      { tool: "Read", input: { file_path: spacedPlanfile } },
      structuredSpacedRead.toolName,
      structuredSpacedRead.toolInput,
    )).toBe(true);

    for (const argument of [
      `unrelated; cat ${planfile}`,
      `unrelated | cat ${planfile}`,
      `prefix ${planfile} suffix`,
    ]) {
      const structuredNonRead = codexSpec.canonicalizeToolCall("exec_command", {
        command: "xargs",
        args: ["cat", argument],
      });
      expect(toolRequirementMatches(
        requirement,
        structuredNonRead.toolName,
        structuredNonRead.toolInput,
      ), argument).toBe(false);
    }

    const malformedWindowsCount = codexSpec.canonicalizeToolCall("exec_command", {
      command: "head",
      args: ["-n", '1"0', "C:/plan.md"],
    });
    expect(toolRequirementMatches(
      { tool: "Read", input: { file_path: "C:/plan.md" } },
      malformedWindowsCount.toolName,
      malformedWindowsCount.toolInput,
    )).toBe(false);

    for (const { literalPath, quotedCommand, unquotedCommand } of bashExpansionReadProofCases()) {
      const literalRequirement: ToolRequirement = {
        tool: "Read",
        input: { file_path: literalPath },
      };
      const unquoted = codexSpec.canonicalizeToolCall("exec_command", {
        command: unquotedCommand,
      });
      expect(toolRequirementMatches(
        literalRequirement,
        unquoted.toolName,
        unquoted.toolInput,
      ), unquotedCommand).toBe(false);

      const quoted = codexSpec.canonicalizeToolCall("exec_command", {
        command: quotedCommand,
      });
      expect(toolRequirementMatches(
        literalRequirement,
        quoted.toolName,
        quoted.toolInput,
      ), quotedCommand).toBe(true);
    }
  });

  it("advances a canonical Read through Codex Bash before the native MCP call", () => {
    const planfile = "/tmp/agent-framework/plans/implement.md";
    const prediction = makePrediction([
      { tool: "Read", input: { file_path: planfile } },
      { tool: "mcp-check" },
    ]);
    const readCall = codexSpec.canonicalizeToolCall("exec_command", {
      command: `sed -n '1,240p' '${planfile}'`,
    });

    expect(decidePrediction(
      prediction,
      readCall.toolName,
      readCall.toolInput,
      0,
    ).decision).toBe("allow");

    const afterRead = advanceRequiredToolsAfterAllowedToolSequence(prediction, [readCall]);
    expect(afterRead.explicitlyRequiredTools).toEqual([{ tool: "mcp-check" }]);

    const mcpCall = codexSpec.canonicalizeToolCall(codexSpec.mcpWireName("check"), {
      working_dir: "/tmp/agent-framework",
    });
    expect(decidePrediction(
      afterRead,
      mcpCall.toolName,
      mcpCall.toolInput,
      0,
    ).decision).toBe("allow");
  });

  it("keeps an MCP queued when Codex Bash satisfies non-blocking Read", () => {
    const prediction = makePrediction([{ tool: "mcp-check" }]);
    const readCall = codexSpec.canonicalizeToolCall("exec_command", {
      command: "sed -n '1,240p' AGENTS.md",
    });

    expect(decidePrediction(
      prediction,
      readCall.toolName,
      readCall.toolInput,
      0,
    ).decision).toBe("allow");
    expect(advanceRequiredToolsAfterAllowedToolSequence(
      prediction,
      [readCall],
    ).explicitlyRequiredTools).toEqual([{ tool: "mcp-check" }]);

    const mcpCall = codexSpec.canonicalizeToolCall(codexSpec.mcpWireName("check"), {});
    expect(decidePrediction(
      prediction,
      mcpCall.toolName,
      mcpCall.toolInput,
      0,
    ).decision).toBe("allow");
  });

  it("keeps Claude native Read and MCP queue progression unchanged", () => {
    const planfile = "/tmp/agent-framework/plans/claude.md";
    const prediction = makePrediction([
      { tool: "Read", input: { file_path: planfile } },
      { tool: "mcp-check" },
    ]);
    const readCall = claudeSpec.canonicalizeToolCall("Read", { file_path: planfile });
    const afterRead = advanceRequiredToolsAfterAllowedToolSequence(prediction, [readCall]);
    expect(afterRead.explicitlyRequiredTools).toEqual([{ tool: "mcp-check" }]);

    const mcpCall = claudeSpec.canonicalizeToolCall(claudeSpec.mcpWireName("check"), {});
    expect(decidePrediction(
      afterRead,
      mcpCall.toolName,
      mcpCall.toolInput,
      0,
    ).decision).toBe("allow");
  });
});
