import type { CanonicalMcp } from "../../src/adapter/types.js";

export type ImplementationWrapperWorkflow = "implement" | "validate";
export type ImplementationWrapperMcp = Extract<CanonicalMcp, "implement" | "validate_implementation">;
export type ImplementationWrapperSurface = "claude-agent" | "claude-command" | "codex-agent" | "codex-skill";

export type ImplementationWrapperTarget = {
  adapter: "claude" | "codex";
  surface: ImplementationWrapperSurface;
  workflow: ImplementationWrapperWorkflow;
  filePath: string;
  mcp: ImplementationWrapperMcp;
};

const TEMPLATE_SOURCE = "adapters/shared/implementation-wrapper-template.ts";

const WORKFLOW_COPY: Record<ImplementationWrapperWorkflow, {
  agentName: string;
  claudeTitle: string;
  workflowDescription: string;
  claudeCommandDescription: string;
  codexSkillName: string;
  codexSkillTitle: string;
  codexSkillDescription: string;
  finalInstructions: readonly string[];
}> = {
  implement: {
    agentName: "implementer",
    claudeTitle: "Implementation Workflow Wrapper",
    workflowDescription: "implementation",
    claudeCommandDescription: "Implement the current plan through the agent-framework implement MCP",
    codexSkillName: "agent-framework-implement",
    codexSkillTitle: "Agent Framework Implement",
    codexSkillDescription: "Implement an approved plan by calling the agent-framework implement MCP. Use when the user invokes $agent-framework-implement.",
    finalInstructions: [
      "- Do not spawn agents yourself.",
      "- Do not run checks yourself.",
    ],
  },
  validate: {
    agentName: "implement-validator",
    claudeTitle: "Implementation Validation Wrapper",
    workflowDescription: "implementation validation",
    claudeCommandDescription: "Validate an implementation against a plan through the agent-framework validate_implementation MCP",
    codexSkillName: "agent-framework-validate",
    codexSkillTitle: "Agent Framework Validate",
    codexSkillDescription: "Validate that a plan was implemented correctly through the agent-framework validate_implementation MCP. Use when the user invokes $agent-framework-validate.",
    finalInstructions: [
      "- Do not validate the implementation yourself before calling the MCP.",
      "- Do not use `validate_plan`; that is only for plan-contract validation.",
    ],
  },
};
type WorkflowCopy = (typeof WORKFLOW_COPY)[ImplementationWrapperWorkflow];

export const IMPLEMENTATION_WRAPPER_TARGETS: readonly ImplementationWrapperTarget[] = [
  {
    adapter: "claude",
    surface: "claude-agent",
    workflow: "implement",
    filePath: "adapters/claude/dotclaude/agents/implementer.md",
    mcp: "implement",
  },
  {
    adapter: "claude",
    surface: "claude-agent",
    workflow: "validate",
    filePath: "adapters/claude/dotclaude/agents/implement-validator.md",
    mcp: "validate_implementation",
  },
  {
    adapter: "claude",
    surface: "claude-command",
    workflow: "implement",
    filePath: "adapters/claude/dotclaude/commands/implement.md",
    mcp: "implement",
  },
  {
    adapter: "claude",
    surface: "claude-command",
    workflow: "validate",
    filePath: "adapters/claude/dotclaude/commands/validate.md",
    mcp: "validate_implementation",
  },
  {
    adapter: "codex",
    surface: "codex-agent",
    workflow: "implement",
    filePath: "adapters/codex/dotcodex/agents/implementer.toml",
    mcp: "implement",
  },
  {
    adapter: "codex",
    surface: "codex-agent",
    workflow: "validate",
    filePath: "adapters/codex/dotcodex/agents/implement-validator.toml",
    mcp: "validate_implementation",
  },
  {
    adapter: "codex",
    surface: "codex-skill",
    workflow: "implement",
    filePath: "adapters/codex/dotcodex/skills/agent-framework-implement/SKILL.md",
    mcp: "implement",
  },
  {
    adapter: "codex",
    surface: "codex-skill",
    workflow: "validate",
    filePath: "adapters/codex/dotcodex/skills/agent-framework-validate/SKILL.md",
    mcp: "validate_implementation",
  },
];

const SHARED_FORWARDING_LINES = [
  "- Pass `working_dir` with the current repository working directory.",
  "- If the prompt, arguments, or active workflow context provides a concrete plan file path, pass it as `planfile`; otherwise omit `planfile` so the MCP resolves the current plan.",
  "- Pass `model_tier` only when the user explicitly requested haiku, sonnet, or opus.",
  "- Pass `extra_context` only as an array of exact quoted user text from the invoking prompt or recent user messages. Do not summarize, infer, or add assistant-created context.",
] as const;

export function renderImplementationWrapper(target: ImplementationWrapperTarget, mcpWireName: string): string {
  const copy = WORKFLOW_COPY[target.workflow];
  if (target.surface === "claude-agent") return renderClaudeAgent(copy, mcpWireName);
  if (target.surface === "claude-command") return renderClaudeCommand(copy, mcpWireName);
  if (target.surface === "codex-agent") return renderCodexAgent(copy, mcpWireName);
  return renderCodexSkill(copy, mcpWireName);
}

function renderClaudeAgent(copy: WorkflowCopy, mcpWireName: string): string {
  return lines([
    "---",
    `name: ${copy.agentName}`,
    `description: Compatibility wrapper for the MCP-owned ${copy.workflowDescription} workflow`,
    `tools: [${mcpWireName}]`,
    "model: sonnet",
    "---",
    "",
    generatedMarkdownComment(),
    "",
    `# ${copy.claudeTitle}`,
    "",
    `This adapter-level agent is retained only for older prompts that spawn \`${copy.agentName}\`.`,
    "",
    `Immediately call \`${mcpWireName}\`.`,
    "",
    "Inputs:",
    ...SHARED_FORWARDING_LINES,
    "- Do not read files, edit files, run checks, or call any other tools.",
    "",
    "Report the MCP result.",
  ]);
}

function renderClaudeCommand(copy: WorkflowCopy, mcpWireName: string): string {
  return lines([
    "---",
    "disable-model-invocation: true",
    `description: ${copy.claudeCommandDescription}`,
    `allowed-tools: ${mcpWireName}`,
    "---",
    "",
    generatedMarkdownComment(),
    "",
    `Immediately call \`${mcpWireName}\`.`,
    "",
    "Inputs:",
    ...SHARED_FORWARDING_LINES,
    ...copy.finalInstructions,
  ]);
}

function renderCodexAgent(copy: WorkflowCopy, mcpWireName: string): string {
  return lines([
    generatedTomlComment(),
    `name = "${copy.agentName}"`,
    `description = "Compatibility wrapper for the MCP-owned ${copy.workflowDescription} workflow."`,
    "model = \"gpt-5.5\"",
    "model_reasoning_effort = \"medium\"",
    "sandbox_mode = \"read-only\"",
    "developer_instructions = \"\"\"",
    `Generated from ${TEMPLATE_SOURCE}. Edit that template and refresh this file.`,
    "",
    `This adapter-level agent is retained only for older prompts that spawn \`${copy.agentName}\`.`,
    "",
    `Use only ${mcpWireName}.`,
    "",
    `Immediately call ${mcpWireName}.`,
    "",
    "Inputs:",
    ...SHARED_FORWARDING_LINES,
    "- Do not read files, edit files, run checks, or call any other tools.",
    "",
    "Report the MCP result.",
    "\"\"\"",
  ]);
}

function renderCodexSkill(copy: WorkflowCopy, mcpWireName: string): string {
  return lines([
    "---",
    `name: ${copy.codexSkillName}`,
    `description: ${copy.codexSkillDescription}`,
    "---",
    "",
    generatedMarkdownComment(),
    "",
    `# ${copy.codexSkillTitle}`,
    "",
    `Immediately call \`${mcpWireName}\`.`,
    "",
    "Inputs:",
    ...SHARED_FORWARDING_LINES,
    "",
    `${copy.finalInstructions.map((line) => line.replace(/^- /, "")).join(" ")} Report the MCP result.`,
  ]);
}

function generatedMarkdownComment(): string {
  return `<!-- Generated from ${TEMPLATE_SOURCE}. Edit that template and refresh this file. -->`;
}

function generatedTomlComment(): string {
  return `# Generated from ${TEMPLATE_SOURCE}. Edit that template and refresh this file.`;
}

function lines(content: readonly string[]): string {
  return `${content.join("\n")}\n`;
}
