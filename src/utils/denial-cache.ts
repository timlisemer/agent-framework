import { CacheManager } from "./cache-manager.js";

const DENIAL_CACHE_FILE = "/tmp/claude-hook-denials.json";
const DENIAL_EXPIRY_MS = 60 * 1000; // 1 minute
const DENIAL_MAX_ENTRIES = 20;
const MAX_SIMILAR_DENIALS = 3;

interface DenialEntry {
  pattern: string;
  count: number;
  timestamp: number;
}

interface DenialData {
  entries: DenialEntry[];
}

const cacheManager = new CacheManager<DenialData>({
  filePath: DENIAL_CACHE_FILE,
  defaultData: () => ({ entries: [] }),
  expiryMs: DENIAL_EXPIRY_MS,
  maxEntries: DENIAL_MAX_ENTRIES,
  getTimestamp: (e) => (e as DenialEntry).timestamp,
  getEntries: (d) => d.entries,
  setEntries: (d, e) => ({ ...d, entries: e as DenialEntry[] }),
});

export function setDenialSession(transcriptPath: string): void {
  cacheManager.setSession(transcriptPath);
}

/**
 * Check if user has sent a new message since last check.
 * If so, clear the denial cache (user interaction = fresh start).
 *
 * Call this at the start of pre-tool-use hook.
 */
export function checkDenialUserInteraction(lastUserMessage: string | undefined): void {
  cacheManager.checkUserMessage(lastUserMessage);
}

/**
 * Load denial entries, cleaning expired ones.
 */
export function loadDenials(): Map<string, { count: number; timestamp: number }> {
  const data = cacheManager.load();
  const map = new Map<string, { count: number; timestamp: number }>();
  for (const entry of data.entries) {
    map.set(entry.pattern, { count: entry.count, timestamp: entry.timestamp });
  }
  return map;
}

/**
 * Record a denial for a pattern. Returns the updated count.
 */
export function recordDenial(pattern: string): number {
  const data = cacheManager.load();
  const existing = data.entries.find((e) => e.pattern === pattern);

  if (existing) {
    existing.count += 1;
    existing.timestamp = Date.now();
  } else {
    data.entries.push({
      pattern,
      count: 1,
      timestamp: Date.now(),
    });
  }

  cacheManager.save(data);
  return existing ? existing.count : 1;
}

/**
 * Get denial count for a pattern.
 */
export function getDenialCount(pattern: string): number {
  const data = cacheManager.load();
  const entry = data.entries.find((e) => e.pattern === pattern);
  return entry?.count ?? 0;
}

/**
 * Check if pattern has exceeded max similar denials threshold.
 */
export function isWorkaroundEscalation(pattern: string): boolean {
  return getDenialCount(pattern) >= MAX_SIMILAR_DENIALS;
}

/**
 * Clear all denial entries.
 */
export function clearDenialCache(): void {
  cacheManager.clear();
}

export { MAX_SIMILAR_DENIALS };
