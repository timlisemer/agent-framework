import "../utils/load-env.js";
import { type StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { checkForOffTopic, extractConversationContext } from "../agents/hooks/intent-validate.js";
import { logToHomeAssistant } from "../utils/logger.js";

// Patterns that indicate AI is asking user to run commands manually
const DELEGATION_PATTERNS = [
  /(?:please |could you |you(?:'ll)? (?:need|can|should) )(?:run|execute|try)/i,
  /run (?:it |this |the command )?(?:yourself|manually)/i,
  /(?:execute|run) the following/i,
];

// Commands that should use MCP tool instead
const BUILD_CHECK_COMMANDS = /\b(?:make check|make build|npm run build|npm run check|tsc|npx tsc|cargo build|cargo check)\b/i;

/**
 * Check if assistant is asking user to run build/check commands manually
 * This is a workaround escape - if these commands were denied, AI should use MCP tool
 */
function checkDelegation(message: string): { isDelegation: boolean; command?: string } {
  const hasDelegationPhrase = DELEGATION_PATTERNS.some(p => p.test(message));
  const commandMatch = message.match(BUILD_CHECK_COMMANDS);

  if (hasDelegationPhrase && commandMatch) {
    return { isDelegation: true, command: commandMatch[0] };
  }
  return { isDelegation: false };
}

/**
 * Stop Hook: Off-Topic Check
 * 
 * This hook runs when the AI stops and is waiting for user input.
 * It detects when the AI has gone off-topic, asked redundant questions,
 * or suggested something irrelevant to what the user asked.
 * 
 * If detected, it injects a system message to course-correct the AI.
 */

async function main() {
  const input: StopHookInput = await new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(JSON.parse(data)));
  });

  // First: Check for delegation workaround (fast regex, no API call)
  const context = await extractConversationContext(input.transcript_path);
  const delegationCheck = checkDelegation(context.lastAssistantMessage);

  if (delegationCheck.isDelegation) {
    await logToHomeAssistant({
      agent: 'stop-delegation-check',
      level: 'decision',
      problem: `AI asked user to run: ${delegationCheck.command}`,
      answer: 'INTERVENE - delegation workaround detected'
    });

    console.log(JSON.stringify({
      continue: true,
      systemMessage: `[BLOCKED] Do not ask the user to run build/check commands (${delegationCheck.command}) manually. Use the mcp__agent-framework__check tool instead, or acknowledge that you cannot perform this action.`
    }));
    process.exit(0);
  }

  // Second: Run the off-topic check (LLM call)
  const result = await checkForOffTopic(input.transcript_path);

  logToHomeAssistant({
    agent: 'stop-off-topic-check',
    level: 'decision',
    problem: 'AI stopped, checking for off-topic',
    answer: result.decision + (result.feedback ? `: ${result.feedback}` : '')
  });

  if (result.decision === 'INTERVENE' && result.feedback) {
    // Inject a system message to course-correct the AI
    // This will be shown to the AI as context before the user responds
    console.log(JSON.stringify({
      continue: true,
      systemMessage: `[COURSE CORRECTION] The previous response may be off-track. ${result.feedback}. Please refocus on what the user originally asked for.`
    }));
    process.exit(0);
  }

  // If OK, just exit cleanly - no intervention needed
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  // On error, exit cleanly to not block the user
  process.exit(0);
});

