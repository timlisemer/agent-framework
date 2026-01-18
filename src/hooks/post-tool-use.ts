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
    const onData = (chunk: Buffer | string) => (data += chunk);
    const onEnd = () => {
      clearTimeout(timeout);
      process.stdin.removeListener("data", onData);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });

  // Clear error acknowledgment cache on ANY successful tool
  await clearAckCache();

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
