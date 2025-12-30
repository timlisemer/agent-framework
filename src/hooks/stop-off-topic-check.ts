import { type StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { checkForOffTopic } from "../agents/hooks/intent-validate.js";
import { logToHomeAssistant } from "../utils/logger.js";

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

  // Run the off-topic check
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

