/**
 * Slash commands that GATE specific MCP tools — those tools cannot run
 * without an explicit slash-command invocation. Single source of truth
 * for RESTRICTED_MCP_TOOLS. Consumed (transitively) by:
 *  - isLowRiskTool (src/rules/utils.ts) — excludes from low-risk auto-approve
 *  - tool-approve  (src/rules/tool-approve.ts:85) — hard-deny without auth
 *  - subagent      (src/rules/subagent.ts:142)    — hard-deny without auth
 */
export const SLASH_COMMAND_GATED_MCP_TOOLS: Record<string, readonly string[]> = {
  commit:    ["mcp__agent-framework__commit"],
  push:      ["mcp__agent-framework__push", "mcp__agent-framework__commit"],
  quickpush: ["mcp__agent-framework__push", "mcp__agent-framework__commit"],
  confirm:   ["mcp__agent-framework__confirm"],
};

/**
 * Per-command workflow tool sets. The tools each slash-command workflow
 * legitimately uses — including non-MCP tools (Agent, ExitPlanMode) the
 * command's body orchestrates.
 *
 * Read by decidePrediction step 3.11 to allow these tools through
 * mood-driven policy when the user has actively invoked the command.
 * The slash-command tag <command-name>/NAME</command-name> persists in
 * the transcript across all internal steps of the workflow, so this
 * single per-command tool set naturally pins authorization for the full
 * multi-step flow until a NEW slash command is invoked or the user
 * issues an explicit revocation.
 *
 * Read/Grep/Glob/LS/Bash are intentionally absent from the plan*
 * entries — they are already low-risk and bypass mood policy via
 * decidePrediction step 4 (isLowRiskTool). Add them here only if a real
 * session shows them denying under sustained frustration during a
 * slash-command workflow.
 */
export const SLASH_COMMAND_WORKFLOW_TOOLS: Record<string, readonly string[]> = {
  plan1:     ["Agent", "ExitPlanMode"],
  plan3:     ["Agent", "ExitPlanMode"],
  plan5:     ["Agent", "ExitPlanMode"],
  implement: ["Agent"],
};

/**
 * Combined view: every tool a slash command authorizes. Consumed by
 * extractSlashCommandMetadata (src/utils/transcript.ts:328) to populate
 * SlashCommandContext.allowedTools for both the appealHelper LLM prompt
 * and decidePrediction step 3.11.
 */
export const SLASH_COMMAND_ALLOWED_TOOLS: Record<string, readonly string[]> = {
  ...SLASH_COMMAND_GATED_MCP_TOOLS,
  ...SLASH_COMMAND_WORKFLOW_TOOLS,
};

const CODEX_AGENT_FRAMEWORK_SKILL_PREFIX = "agent-framework-";

export function codexSkillNameToCommandName(skillName: string): string | undefined {
  if (!skillName.startsWith(CODEX_AGENT_FRAMEWORK_SKILL_PREFIX)) return undefined;
  const commandName = skillName.slice(CODEX_AGENT_FRAMEWORK_SKILL_PREFIX.length);
  return SLASH_COMMAND_ALLOWED_TOOLS[commandName] ? commandName : undefined;
}

export function extractCodexSkillCommandName(content: string): string | undefined {
  const skillMatch = content.match(/(?:^|\s)\$agent-framework-([\w-]+)\b/);
  if (!skillMatch) return undefined;
  return codexSkillNameToCommandName(`${CODEX_AGENT_FRAMEWORK_SKILL_PREFIX}${skillMatch[1]}`);
}

export const RESTRICTED_MCP_TOOLS: ReadonlySet<string> = new Set(
  Object.values(SLASH_COMMAND_GATED_MCP_TOOLS).flat(),
);
