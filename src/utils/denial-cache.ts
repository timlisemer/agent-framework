import { CacheManager } from "./cache-manager.js";
import { sessionDenialCacheFile } from "./paths.js";

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

let cacheManager: CacheManager<DenialData> | null = null;

/**
 * Initialize the denial cache for a session directory.
 * Call once per hook invocation after computing sessionDir.
 */
export function initDenialSession(sessionDir: string): void {
  cacheManager = new CacheManager<DenialData>({
    filePath: sessionDenialCacheFile(sessionDir),
    defaultData: () => ({ entries: [] }),
    expiryMs: DENIAL_EXPIRY_MS,
    maxEntries: DENIAL_MAX_ENTRIES,
    getTimestamp: (e) => (e as DenialEntry).timestamp,
    getEntries: (d) => d.entries,
    setEntries: (d, e) => ({ ...d, entries: e as DenialEntry[] }),
  });
}

function getManager(): CacheManager<DenialData> {
  if (!cacheManager) {
    throw new Error("denial-cache: initDenialSession() must be called before use");
  }
  return cacheManager;
}

/**
 * Check if user has sent a new message since last check.
 * If so, clear the denial cache (user interaction = fresh start).
 *
 * Call this at the start of pre-tool-use hook.
 */
export async function checkDenialUserInteraction(lastUserMessage: string | undefined): Promise<void> {
  await getManager().checkUserMessage(lastUserMessage);
}

/**
 * Load denial entries, cleaning expired ones.
 */
export async function loadDenials(): Promise<Map<string, { count: number; timestamp: number }>> {
  const data = await getManager().load();
  const map = new Map<string, { count: number; timestamp: number }>();
  for (const entry of data.entries) {
    map.set(entry.pattern, { count: entry.count, timestamp: entry.timestamp });
  }
  return map;
}

/**
 * Record a denial for a pattern. Returns the updated count.
 */
export async function recordDenial(pattern: string): Promise<number> {
  const data = await getManager().load();
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

  await getManager().save(data);
  return existing ? existing.count : 1;
}

/**
 * Get denial count for a pattern.
 */
export async function getDenialCount(pattern: string): Promise<number> {
  const data = await getManager().load();
  const entry = data.entries.find((e) => e.pattern === pattern);
  return entry?.count ?? 0;
}

/**
 * Check if pattern has exceeded max similar denials threshold.
 */
export async function isWorkaroundEscalation(pattern: string): Promise<boolean> {
  return (await getDenialCount(pattern)) >= MAX_SIMILAR_DENIALS;
}

/**
 * Clear all denial entries.
 */
export async function clearDenialCache(): Promise<void> {
  await getManager().clear();
}

export { MAX_SIMILAR_DENIALS };
