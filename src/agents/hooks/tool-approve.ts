/**
 * Tool Approve Agent - Policy Enforcement Gate
 *
 * This agent evaluates tool calls for safety and compliance with project rules.
 * It's the first line of defense in the pre-tool-use hook.
 *
 * ## FLOW
 *
 * 1. Load project rules from CLAUDE.md if exists
 * 2. Get blacklist pattern highlights for the tool call
 * 3. Run unified agent to evaluate
 * 4. Retry if format is invalid
 * 5. Return APPROVE or DENY with reason
 *
 * ## RULES ENFORCED
 *
 * - File operations: Deny outside project, deny sensitive files
 * - Bash: Deny cd, deny tool duplication, deny git write ops
 * - Build: Deny make check/build (use MCP tools)
 * - Network: Deny curl/wget by default
 *
 * See agent-configs.ts for full rule list.
 *
 * @module tool-approve
 */

import * as fs from 'fs';
import * as path from 'path';
import { getModelId } from '../../types.js';
import { runAgent } from '../../utils/agent-runner.js';
import { TOOL_APPROVE_AGENT } from '../../utils/agent-configs.js';
import { getAnthropicClient } from '../../utils/anthropic-client.js';
import { getBlacklistHighlights } from '../../utils/command-patterns.js';
import { logToHomeAssistant } from '../../utils/logger.js';
import { retryUntilValid, startsWithAny } from '../../utils/retry.js';

/**
 * Evaluate a tool call for safety and compliance.
 *
 * @param toolName - Name of the tool being called
 * @param toolInput - Input parameters for the tool
 * @param projectDir - The project directory for context
 * @returns Approval result with optional denial reason
 *
 * @example
 * ```typescript
 * const result = await approveTool('Bash', { command: 'rm -rf /' }, '/path/to/project');
 * if (!result.approved) {
 *   console.log('Denied:', result.reason);
 * }
 * ```
 */
export async function approveTool(
  toolName: string,
  toolInput: unknown,
  projectDir: string
): Promise<{ approved: boolean; reason?: string }> {
  // Load CLAUDE.md if exists (project-specific rules)
  let rules = '';
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    rules = fs.readFileSync(claudeMdPath, 'utf-8');
  }

  const toolDescription = `${toolName} with ${JSON.stringify(toolInput)}`;

  // Get blacklist pattern highlights for this tool call
  const highlights = getBlacklistHighlights(toolName, toolInput);
  const highlightSection =
    highlights.length > 0
      ? `\n=== BLACKLISTED PATTERNS DETECTED ===\n${highlights.join('\n')}\n=== END BLACKLIST ===\n`
      : '';

  // Run initial evaluation via unified runner
  const initialResponse = await runAgent(
    { ...TOOL_APPROVE_AGENT, workingDir: projectDir },
    {
      prompt: 'Evaluate this tool call for safety and compliance.',
      context: `PROJECT DIRECTORY: ${projectDir}

PROJECT RULES (from CLAUDE.md):
${rules || 'No project-specific rules.'}
${highlightSection}
TOOL TO EVALUATE:
Tool: ${toolName}
Input: ${JSON.stringify(toolInput)}`,
    }
  );

  // Retry if format is invalid (must start with APPROVE or DENY:)
  const anthropic = getAnthropicClient();
  const decision = await retryUntilValid(
    anthropic,
    getModelId('haiku'),
    initialResponse,
    toolDescription,
    {
      maxRetries: 2,
      formatValidator: (text) => startsWithAny(text, ['APPROVE', 'DENY:']),
      formatReminder: 'Reply with EXACTLY: APPROVE or DENY: <reason>',
    }
  );

  if (decision.startsWith('APPROVE')) {
    logToHomeAssistant({
      agent: 'tool-approve',
      level: 'decision',
      problem: toolDescription,
      answer: 'APPROVED',
    });
    return { approved: true };
  }

  // Default to DENY for safety - extract reason from response
  const reason = decision.startsWith('DENY: ')
    ? decision.replace('DENY: ', '')
    : `Malformed response: ${decision}`;

  logToHomeAssistant({
    agent: 'tool-approve',
    level: 'decision',
    problem: toolDescription,
    answer: `DENIED: ${reason}`,
  });

  return {
    approved: false,
    reason,
  };
}
