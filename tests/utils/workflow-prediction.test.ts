import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  advanceRequiredToolsAfterAllowedToolSequence,
  decidePrediction,
  decideRequiredWorkflowToolSequence,
  deriveWorkflowToolRequirementsFromText,
  toolRequirementMatches,
  type ToolPrediction,
  type ToolRequirement,
} from "../../src/utils/prediction-types.js";
import type { CanonicalWorkflow, HostContext } from "../../src/adapter/types.js";
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
      req("mcp-implement", undefined, undefined, ["working_dir"]),
    ]);
    expect(decidePrediction(prediction, "Agent", { subagent_type: "implementer" }, 5).decision).toBe("deny");
    expect(decidePrediction(prediction, "mcp-implement", { planfile: "/repo/plan.md" }, 5).decision).toBe("deny");
    expect(decidePrediction(prediction, "mcp-implement", { working_dir: "/repo", planfile: "/repo/plan.md" }, 5).decision).toBe("allow");
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

  it("canonicalizes Codex wait and close lifecycle tools for workflow matching", () => {
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
});
