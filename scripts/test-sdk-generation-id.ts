/**
 * Test script to debug SDK message structure and find OpenRouter generation ID
 *
 * This script makes a simple SDK query and logs the full structure of each message
 * to help identify where the OpenRouter generation ID is located.
 *
 * Usage:
 *   # Test with Anthropic directly:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/test-sdk-generation-id.ts
 *
 *   # Test with OpenRouter:
 *   ANTHROPIC_BASE_URL=https://openrouter.ai/api \
 *   ANTHROPIC_AUTH_TOKEN=sk-or-... \
 *   npx tsx scripts/test-sdk-generation-id.ts
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import "dotenv/config";

// Default to a working Claude model - haiku is fastest for testing
const DEFAULT_MODEL = "claude-3-5-haiku-latest";

async function main() {
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  console.log("=".repeat(70));
  console.log("SDK Generation ID Debug Script");
  console.log("=".repeat(70));
  console.log("\nUsing model:", model);
  console.log("\nStarting SDK query...\n");

  const q = query({
    prompt: "Say 'Hello' and nothing else.",
    options: {
      model,
      cwd: process.cwd(),
      systemPrompt: "You are a test assistant. Be brief.",
      tools: [],
      allowedTools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
      env: process.env, // Pass env to subprocess (matches agent-runner fix)
    },
  });

  // Simulate agent-runner's generation ID collection
  const generationIds: string[] = [];
  let messageCount = 0;

  for await (const message of q) {
    messageCount++;
    const msgAny = message as Record<string, unknown>;

    console.log(`\n[Message #${messageCount}] type=${message.type}`);

    if (message.type === "assistant") {
      const assistantMsg = msgAny.message as Record<string, unknown> | undefined;
      const id = assistantMsg?.id;
      console.log(`  message.message.id = ${id ?? "(undefined)"}`);

      // Simulate agent-runner logic (always capture - OpenRouter is always used)
      if (assistantMsg?.id && typeof assistantMsg.id === "string") {
        generationIds.push(assistantMsg.id);
        console.log(`  -> Captured generation ID: ${assistantMsg.id}`);
      } else {
        console.log("  -> NOT captured (id missing or wrong type)");
      }
    }

    if (message.type === "result") {
      break;
    }
  }

  // Final result
  console.log("\n" + "=".repeat(70));
  console.log("RESULT");
  console.log("=".repeat(70));
  console.log(`Generation IDs captured: ${generationIds.length}`);
  if (generationIds.length > 0) {
    console.log(`Generation ID value: ${generationIds.join(",")}`);
  }

  // Success/failure
  const success = generationIds.length > 0;
  console.log(`\nTest ${success ? "PASSED" : "FAILED"}`);
  if (!success) {
    console.log("ERROR: No generation ID was captured!");
    process.exit(1);
  }
}

main().catch(console.error);
