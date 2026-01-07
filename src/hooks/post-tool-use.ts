import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { type PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { clearAckCache } from "../utils/ack-cache.js";
import { logToHomeAssistant } from "../utils/logger.js";

async function main() {
  const input: PostToolUseHookInput = await new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(JSON.parse(data)));
  });

  // Clear error acknowledgment cache on ANY successful tool
  clearAckCache();
  logToHomeAssistant({
    agent: "post-tool-use",
    level: "info",
    problem: `${input.tool_name} succeeded`,
    answer: "Cleared error acknowledgment cache",
  });

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
