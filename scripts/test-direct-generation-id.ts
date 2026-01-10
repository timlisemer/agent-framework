/**
 * Test script to verify direct API calls capture generation IDs correctly.
 * Uses runAgent from agent-runner.ts - same code path as hooks.
 *
 * Run with: npx tsx scripts/test-direct-generation-id.ts
 */

import { runAgent } from "../src/utils/agent-runner.js";
import { MODEL_TIERS } from "../src/types.js";

async function main() {
  console.log("=".repeat(70));
  console.log("Direct API Generation ID Test");
  console.log("=".repeat(70));

  console.log("\nCalling runAgent with mode='direct'...\n");

  const result = await runAgent(
    {
      name: "test-direct",
      tier: MODEL_TIERS.HAIKU,
      mode: "direct",
      systemPrompt: "You are a test assistant. Be brief.",
      maxTokens: 100,
    },
    {
      prompt: "Say 'Hello' and nothing else.",
    }
  );

  console.log("Result received:");
  console.log(`  output: ${result.output}`);
  console.log(`  success: ${result.success}`);
  console.log(`  generationId: ${result.generationId ?? "(undefined)"}`);

  console.log("\n" + "=".repeat(70));
  console.log("RESULT");
  console.log("=".repeat(70));
  console.log(`Generation ID captured: ${result.generationId ?? "NONE"}`);

  const success = !!result.generationId;
  console.log(`\nTest ${success ? "PASSED" : "FAILED"}`);
  if (!success) {
    console.log("ERROR: No generation ID found!");
    process.exit(1);
  }
}

main().catch(console.error);
