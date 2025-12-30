import { type PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import { approveTool } from '../agents/tool-approve.js';
import { appealDenial } from '../agents/tool-appeal.js';
import { logToHomeAssistant } from '../utils/logger.js';

async function readRecentTranscript(
  path: string,
  lines: number
): Promise<string> {
  const content = await fs.promises.readFile(path, 'utf-8');
  const entries = content.trim().split('\n').slice(-lines);

  return entries
    .map((line) => {
      try {
        const entry = JSON.parse(line);
        if (entry.message?.role === 'user' && entry.message?.content) {
          const text =
            typeof entry.message.content === 'string'
              ? entry.message.content
              : JSON.stringify(entry.message.content);
          return `USER: ${text}`;
        }
        if (entry.message?.role === 'assistant' && entry.message?.content) {
          const textBlocks = entry.message.content
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { text: string }) => b.text)
            .join(' ');
          if (textBlocks) return `ASSISTANT: ${textBlocks}`;
        }
        return null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .join('\n');
}

async function main() {
  const input: PreToolUseHookInput = await new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(JSON.parse(data)));
  });

  // Auto-approve low-risk tools and ALL MCP tools
  // These tools are read-only or have no filesystem/system impact
  const LOW_RISK_TOOLS = [
    // Read-only search/navigation
    'LSP', // Language server protocol queries
    'Grep', // File content search
    'Glob', // File pattern matching
    'WebSearch', // Web search
    'WebFetch', // Fetch web content

    // MCP resource reading (read-only)
    'ListMcpResources', // List available MCP resources
    'ReadMcpResource', // Read an MCP resource

    // Internal/meta tools (low impact)
    'TodoWrite', // Task list management (internal to Claude)
    'TaskOutput', // Read output from background tasks
    'AskUserQuestion', // Prompts user for input (safe)
    'ExitPlanMode', // Exit plan mode (internal to Claude)
    'EnterPlanMode', // Enter plan mode (internal to Claude)
    'Skill', // Invoke skills like /commit (user-initiated)
  ];
  if (
    LOW_RISK_TOOLS.includes(input.tool_name) ||
    input.tool_name.startsWith('mcp__')
  ) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      })
    );
    process.exit(0);
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const decision = await approveTool(
    input.tool_name,
    input.tool_input,
    projectDir
  );

  const toolDescription = `${input.tool_name} with ${JSON.stringify(
    input.tool_input
  )}`;

  logToHomeAssistant({
    agent: 'pre-tool-use-hook',
    level: 'decision',
    problem: toolDescription,
    answer: decision.approved ? 'ALLOWED' : `DENIED: ${decision.reason}`,
  });

  if (!decision.approved) {
    // Layer 2: Appeal with transcript context
    const transcript = await readRecentTranscript(input.transcript_path, 50);
    const appeal = await appealDenial(
      input.tool_name,
      input.tool_input,
      transcript,
      decision.reason || 'No reason provided'
    );

    if (appeal.approved) {
      logToHomeAssistant({
        agent: 'pre-tool-use-hook',
        level: 'decision',
        problem: toolDescription,
        answer: 'APPEALED',
      });
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        })
      );
      process.exit(0); // Allow on successful appeal
    }

    // Output structured JSON to deny and provide feedback to Claude
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: appeal.reason ?? decision.reason,
        },
      })
    );
    process.exit(0);
  }

  // Explicitly allow approved tools
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    })
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
