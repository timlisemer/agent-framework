#!/usr/bin/env node
/**
 * Detached telemetry sender - receives events via argv and sends to API.
 * Runs independently of parent process, ensuring telemetry is sent even
 * when the parent process exits immediately after spawning.
 *
 * Usage: node telemetry-sender.js <events-json> <endpoint> <api-key>
 */

const events = JSON.parse(process.argv[2]);
const endpoint = process.argv[3];
const apiKey = process.argv[4];

if (!events || !endpoint || !apiKey) {
  console.error("[Telemetry Sender] Missing required arguments");
  process.exit(1);
}

fetch(`${endpoint}/api/v1/telemetry/batch`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
  },
  body: JSON.stringify({ events }),
})
  .then((r) => {
    if (!r.ok) {
      console.error(`[Telemetry Sender] Failed: ${r.status}`);
    }
  })
  .catch((e) => {
    console.error(`[Telemetry Sender] Error: ${e instanceof Error ? e.message : e}`);
  })
  .finally(() => {
    process.exit(0);
  });
