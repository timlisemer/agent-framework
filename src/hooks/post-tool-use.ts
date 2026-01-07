import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { type PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { clearAckCache } from "../utils/ack-cache.js";

async function main() {
  // Read input but we only use this hook for side effects
  await new Promise<PostToolUseHookInput>((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(JSON.parse(data)));
  });

  // Clear error acknowledgment cache on ANY successful tool
  clearAckCache();

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
