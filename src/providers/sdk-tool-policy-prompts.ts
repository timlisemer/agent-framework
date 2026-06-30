export const WRITE_POLICY_RUNTIME_SURFACE =
  "the full configured adapter tool surface from the internal write runtime home";

export const WRITE_POLICY_GUARDRAILS =
  "Bash, edits, and MCP tool calls still flow through agent-framework guardrails.";

export function writePolicyRuntimeAccessSentence(): string {
  return `You have access to ${WRITE_POLICY_RUNTIME_SURFACE}, including file edit tools and MCP tools. ${WRITE_POLICY_GUARDRAILS}`;
}
