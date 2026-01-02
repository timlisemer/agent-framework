import { CacheManager } from "./cache-manager.js";

const ACK_CACHE_FILE = "/tmp/claude-error-acks.json";
const ACK_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const ACK_MAX_ENTRIES = 20;

interface AckEntry {
  errorHash: string;
  errorSnippet: string;
  acknowledgedAt: number;
}

interface AckData {
  entries: AckEntry[];
}

const cacheManager = new CacheManager<AckData>({
  filePath: ACK_CACHE_FILE,
  defaultData: () => ({ entries: [] }),
  expiryMs: ACK_EXPIRY_MS,
  maxEntries: ACK_MAX_ENTRIES,
  getTimestamp: (e) => (e as AckEntry).acknowledgedAt,
  getEntries: (d) => d.entries,
  setEntries: (d, e) => ({ ...d, entries: e as AckEntry[] }),
});

function hashError(error: string): string {
  // Use same hash as cache-manager for consistency
  const crypto = require("crypto");
  return crypto.createHash("md5").update(error).digest("hex").slice(0, 8);
}

export function setSession(transcriptPath: string): void {
  cacheManager.setSession(transcriptPath);
}

export function isErrorAcknowledged(errorSnippet: string): boolean {
  const data = cacheManager.load();
  const hash = hashError(errorSnippet);
  return data.entries.some((e) => e.errorHash === hash);
}

export function markErrorAcknowledged(errorSnippet: string): void {
  const data = cacheManager.load();
  const hash = hashError(errorSnippet);

  // Don't duplicate
  if (data.entries.some((e) => e.errorHash === hash)) return;

  data.entries.push({
    errorHash: hash,
    errorSnippet: errorSnippet.slice(0, 100),
    acknowledgedAt: Date.now(),
  });
  cacheManager.save(data);
}

export function clearAckCache(): void {
  cacheManager.clear();
}

/**
 * Check if user has sent a new message since last check.
 * If so, clear the ack cache (user interaction = fresh start).
 *
 * Call this at the start of pre-tool-use hook.
 */
export function checkUserInteraction(lastUserMessage: string | undefined): void {
  cacheManager.checkUserMessage(lastUserMessage);
}
