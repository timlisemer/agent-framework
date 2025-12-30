import * as fs from 'fs';
import * as path from 'path';
import { getModelId } from '../../types.js';
import { getAnthropicClient } from '../../utils/anthropic-client.js';
import { getBlacklistHighlights } from '../../utils/command-patterns.js';
import { logToHomeAssistant } from '../../utils/logger.js';
import { extractTextFromResponse } from '../../utils/response-parser.js';
import { retryUntilValid, startsWithAny } from '../../utils/retry.js';

export async function approveTool(
  toolName: string,
  toolInput: unknown,
  projectDir: string
): Promise<{ approved: boolean; reason?: string }> {
  // Load CLAUDE.md if exists
  let rules = '';
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    rules = fs.readFileSync(claudeMdPath, 'utf-8');
  }

  const anthropic = getAnthropicClient();
  const toolDescription = `${toolName} with ${JSON.stringify(toolInput)}`;

  const highlights = getBlacklistHighlights(toolName, toolInput);
  const highlightSection =
    highlights.length > 0
      ? `\n=== BLACKLISTED PATTERNS DETECTED ===\n${highlights.join('\n')}\n=== END BLACKLIST ===\n`
      : '';

  const response = await anthropic.messages.create({
    model: getModelId('haiku'),
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: `You are a tool approval gate. Evaluate tool calls for safety and compliance.

PROJECT DIRECTORY: ${projectDir}
PROJECT RULES (from CLAUDE.md):
${rules || 'No project-specific rules.'}
${highlightSection}
TOOL TO EVALUATE:
Tool: ${toolName}
Input: ${JSON.stringify(toolInput)}

=== UNIVERSAL RULES ===

- DENY modifying files outside project directory (Edit/Write/NotebookEdit)
- ALLOW reading files outside project (Read) for documentation/resources, BUT deny sensitive files
- DENY sensitive files anywhere: .env, credentials.json, secrets.*, id_rsa, private keys, ~/.ssh/, ~/.aws/credentials, etc.

=== TOOL-SPECIFIC RULES ===

For Read:
- ALLOW reading files outside project for documentation/reference purposes
- DENY if reading sensitive files (credentials, private keys, ~/.ssh/, .env, ~/.aws/, etc.)
- ALLOW reading within project (except sensitive files)

For Edit/Write/NotebookEdit:
- DENY if file path is outside project directory
- DENY if editing sensitive files (.env, credentials, secrets, keys)
- DENY if editing system files (/etc, /sys, /proc, /usr, /var)

For Bash commands:

=== CONDITIONALLY ALLOWED ===

rm, mv: APPROVE only if ALL paths are within the project directory.
- Verify no path escapes project root (watch for "..", absolute paths outside project, symlinks)
- Be extra cautious - when in doubt, DENY

sqlite3: APPROVE only for read-only operations.
- ALLOW: SELECT queries, .tables, .schema, .dump, PRAGMA (read info)
- DENY: INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, ATTACH

=== ALWAYS DENY FOR BASH ===

1. cd command (ANY form, no exceptions)
   - DENY: cd /path, cd && cmd, cd /path && cmd, etc.
   - AIs must stay in their starting directory - changing dirs causes state confusion
   - For "cd /path && <cmd>": suggest running <cmd> with absolute paths or --prefix/--manifest-path flags
   - For "cd /path && git <cmd>": suggest just "git <cmd>" (git works from any directory)

2. Bash commands that duplicate AI tools
   - cat/head/tail → use Read tool
   - grep/rg → use Grep tool
   - find → use Glob tool
   - echo > file → use Write tool
   - Principle: AI tools exist for a reason, use them over bash equivalents

3. Commands duplicating Makefile targets (check if Makefile exists first)
   - If project has Makefile, deny raw build commands covered by make targets
   - Examples: "cargo check" when "make check" exists, "npm run build" when "make build" exists
   - Suggest the appropriate make target instead

4. Non-read-only git commands
   - DENY: git commit, git push, git merge, git rebase, git reset, git checkout -b, git branch -d, git add
   - ALLOW: git status, git log, git diff, git show, git branch (list), git stash

5. Persistent background processes
   - DENY commands that start processes surviving after Claude Code exits
   - Examples: docker compose up, docker run (without --rm), systemctl start, nohup, daemon processes
   - These waste resources and user may never realize they're running

6. "Run" commands (application execution)
   - Generally DENY: make run, cargo run, npm run start, npm run dev, docker compose up
   - ALLOW: npm run build, npm run check, npm run test (these run and exit)
   - Key distinction: deny long-running servers/apps, allow commands that complete and exit

7. Secret/credential exposure
   - Commands that could leak API keys, tokens, passwords but you can allow if the command is trying to redact them. For example cat with regex to redact the secret.

8. System modifications outside project
   - Commands affecting files outside project directory

9. make check command
   - DENY: make check (use MCP tool for better integration)
   - Suggest: use mcp__agent-framework__check tool instead
   - IMPORTANT: Do not attempt workarounds like tsc, npx tsc, or direct compiler calls. If MCP tool fails, ask the user for help.

10. build commands like make build, npm run build, etc.
   - DENY: AIs are not intended to build the project. Use the mcp__agent-framework__check tool for validation.
   - IMPORTANT: Do not attempt alternative build commands. If validation fails, ask the user for guidance.

11. curl/wget commands (network requests)
   - DENY by default (requires explicit user permission via transcript appeal)
   - User must explicitly request or approve the curl command

=== SOFT WARNING: COMPLEXITY ===

Overly complex/bloated commands - evaluate carefully:
- If you can't understand what it does in ~1 second, it's likely too complex
- Watch for: redundant cd to current dir, unnecessary flags, over-engineered pipes
- Example bloat: "make -C /already/here check" or "cd /already/here && make check" when just "make check" works
- AIs love adding unnecessary flags - question every flag that isn't strictly required
- Complex commands aren't auto-denied but require clear justification

===== OUTPUT FORMAT (STRICT) =====
Your response MUST start with EXACTLY one of these two formats. DO NOT add any explanation before the decision:

APPROVE
OR
DENY: <specific reason and suggested alternative>

NO other text before the decision word. NO explanations first. NO preamble.`,
      },
    ],
  });

  const decision = await retryUntilValid(
    anthropic,
    getModelId('haiku'),
    extractTextFromResponse(response),
    toolDescription,
    {
      maxRetries: 2,
      formatValidator: (text) => startsWithAny(text, ['APPROVE', 'DENY:']),
      formatReminder: 'Reply with EXACTLY: APPROVE or DENY: <reason>',
    }
  );

  if (decision.startsWith('APPROVE')) {
    await logToHomeAssistant({
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

  await logToHomeAssistant({
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
