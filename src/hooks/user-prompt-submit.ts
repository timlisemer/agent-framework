import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import * as path from "path";
import { fileURLToPath } from "url";
import { readStdinJson, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { spawnBackground } from "../utils/spawn-background.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * UserPromptSubmit Hook
 *
 * Fires when the user submits a prompt. Spawns background summary-updater
 * in intent mode to update User Intent and User Approvals sections.
 */

interface UserPromptSubmitHookInput {
  prompt: string;
  transcript_path: string;
}

async function main() {
  const input = await readStdinJson<UserPromptSubmitHookInput>();

  // Skip for subagents
  if (isSubagent(input.transcript_path)) {
    exitAfterFlush(0);
    return;
  }

  // Spawn background summary-updater in intent mode
  const updaterPath = path.join(__dirname, "../utils/summary-updater.js");
  const encodedPrompt = Buffer.from(input.prompt).toString("base64");

  spawnBackground(updaterPath, [
    "--mode", "intent",
    "--transcript", input.transcript_path,
    "--prompt", encodedPrompt,
  ]);

  exitAfterFlush(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
