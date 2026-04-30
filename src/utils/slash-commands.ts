/**
 * Canonical slash-command → allowed-MCP-tools mapping.
 *
 * Single source of truth for which MCP tool each slash command permits.
 * Consumers:
 * - `extractSlashCommandMetadata` in src/utils/transcript.ts resolves
 *   `<command-name>/NAME</command-name>` invocations to allowed-tools
 *   without file I/O.
 * - `isLowRiskTool` in src/rules/utils.ts uses the derived set to keep
 *   these three MCP tools OUT of the low-risk auto-approval bypass.
 * - `TOOL_APPROVE_PROMPT_SECTION` and `TOOL_APPEAL_AGENT` prompts document
 *   the same mapping in prose (src/utils/agent-configs.ts) -- keep them
 *   in sync with the map below.
 *
 * New slash commands that allow MCP side-effect tools must be added here
 * AND to the corresponding agent prompts in agent-configs.ts.
 */
export const SLASH_COMMAND_ALLOWED_TOOLS: Record<string, readonly string[]> = {
  commit: ["mcp__agent-framework__commit"],
  push: ["mcp__agent-framework__push", "mcp__agent-framework__commit"],
  quickpush: ["mcp__agent-framework__push", "mcp__agent-framework__commit"],
  confirm: ["mcp__agent-framework__confirm"],
};

/**
 * The set of MCP tool names that require an explicit slash-command
 * invocation to run. Derived from `SLASH_COMMAND_ALLOWED_TOOLS` so any
 * new entry propagates automatically.
 *
 * These are the tools that `tool-approve` hard-denies and that
 * `isLowRiskTool` must exclude from the low-risk allow set so trust-based
 * auto-approval cannot silently run them.
 */
export const RESTRICTED_MCP_TOOLS: ReadonlySet<string> = new Set(
  Object.values(SLASH_COMMAND_ALLOWED_TOOLS).flat(),
);
