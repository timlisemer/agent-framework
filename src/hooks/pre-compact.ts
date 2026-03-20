import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { execSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import { readStdinJson, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * PreCompact Hook
 *
 * Force-runs summary-updater SYNCHRONOUSLY before context compaction.
 * This ensures the summary is up-to-date before the transcript is compacted.
 */

interface PreCompactHookInput {
  transcript_path: string;
}

async function main() {
  const input = await readStdinJson<PreCompactHookInput>();

  if (isSubagent(input.transcript_path)) {
    exitAfterFlush(0);
    return;
  }

  const updaterPath = path.join(__dirname, "../utils/summary-updater.js");

  // Run both modes synchronously - compaction is imminent
  try {
    execSync(`node ${JSON.stringify(updaterPath)} --mode actions --transcript ${JSON.stringify(input.transcript_path)}`, {
      timeout: 55000,
      stdio: "ignore",
    });
  } catch {
    // Timeout or error - summary may be incomplete
    console.error("[pre-compact] Summary update (actions) failed or timed out");
  }

  exitAfterFlush(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
