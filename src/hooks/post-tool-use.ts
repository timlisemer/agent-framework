import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { type PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { clearAckCache } from "../utils/ack-cache.js";

async function main() {
  // Read input but we only use this hook for side effects
  await new Promise<PostToolUseHookInput>((resolve, reject) => {
    let data = "";
    const timeout = setTimeout(() => reject(new Error("stdin timeout")), 30000);
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
  });

  // Clear error acknowledgment cache on ANY successful tool
  await clearAckCache();

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
