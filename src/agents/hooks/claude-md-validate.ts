/**
 * CLAUDE.md Validation Agent
 *
 * Validates CLAUDE.md file edits by spawning a built-in Explore subagent
 * to investigate the source repository for documentation patterns.
 *
 * ## FLOW
 *
 * 1. Check session cache for previously fetched rules
 * 2. Run SDK agent with Task tool enabled
 * 3. Agent spawns Explore subagent to investigate GitHub repo
 * 4. Compare proposed content against discovered patterns
 * 5. Return APPROVED or REJECTED verdict
 *
 * ## SESSION CACHING
 *
 * GitHub rules are cached per Claude Code session to avoid repeated
 * exploration. Cache is invalidated when transcript_path changes
 * (indicating a new session).
 *
 * @module claude-md-validate
 */

import { runAgent } from '../../utils/agent-runner.js';
import { CLAUDE_MD_VALIDATE_AGENT } from '../../utils/agent-configs.js';
import { setRewindSession, detectRewind } from '../../utils/rewind-cache.js';

// Session cache for GitHub rules (fetched once per session)
let cachedRules: string | null = null;
let cacheSessionId: string | null = null;

/**
 * Clear the cached rules (called on rewind detection).
 */
export function clearCachedRules(): void {
  cachedRules = null;
}

/**
 * Validate CLAUDE.md content against project conventions.
 *
 * Uses a sonnet SDK agent that spawns a built-in Explore subagent
 * to fetch documentation patterns from the GitHub repo.
 *
 * @param content - The proposed CLAUDE.md content to validate
 * @param sessionId - Session identifier (transcript_path) for caching
 * @returns Validation result with approved status and reason
 *
 * @example
 * ```typescript
 * const result = await validateClaudeMd(newContent, input.transcript_path);
 * if (!result.approved) {
 *   // Block the Write/Edit operation
 * }
 * ```
 */
export async function validateClaudeMd(
  content: string,
  sessionId: string
): Promise<{ approved: boolean; reason: string }> {
  // Set session for rewind detection
  setRewindSession(sessionId);

  // Check for rewind - if detected, clear cached rules
  const rewound = await detectRewind(sessionId);
  if (rewound) {
    cachedRules = null;
  }

  // Invalidate cache on new session
  if (cacheSessionId !== sessionId) {
    cachedRules = null;
    cacheSessionId = sessionId;
  }

  const result = await runAgent(
    { ...CLAUDE_MD_VALIDATE_AGENT, workingDir: process.cwd() },
    {
      prompt: 'Validate this CLAUDE.md content:',
      context: `PROPOSED CLAUDE.MD CONTENT:\n${content}${cachedRules ? `\n\nCACHED RULES (skip exploration, use these):\n${cachedRules}` : ''}`,
    }
  );

  // Cache explorer findings for future validations in this session
  const findingsMatch = result.match(
    /## Explorer Findings\n([\s\S]*?)(?=\n## Validation)/
  );
  if (findingsMatch) {
    cachedRules = findingsMatch[1].trim();
  }

  const approved = result.includes('APPROVED');
  return { approved, reason: result };
}
