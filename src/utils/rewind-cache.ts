import * as fs from "fs";
import { CacheManager } from "./cache-manager.js";
import { hashString } from "./hash-utils.js";
import { clearAckCache } from "./ack-cache.js";
import { clearDenialCache } from "./denial-cache.js";
import { logToHomeAssistant } from "./logger.js";

const REWIND_CACHE_FILE = "/tmp/claude-rewind-cache.json";
const REWIND_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHED_MESSAGES = 20;

interface CachedUserMessage {
  hash: string;
  snippet: string;
  index: number;
  timestamp: number;
}

interface RewindData {
  userMessages: CachedUserMessage[];
  firstResponseChecked: boolean;
}

const cacheManager = new CacheManager<RewindData>({
  filePath: REWIND_CACHE_FILE,
  defaultData: () => ({ userMessages: [], firstResponseChecked: false }),
  expiryMs: REWIND_EXPIRY_MS,
  maxEntries: MAX_CACHED_MESSAGES,
  getTimestamp: (e) => (e as CachedUserMessage).timestamp,
  getEntries: (d) => d.userMessages,
  setEntries: (d, e) => ({ ...d, userMessages: e as CachedUserMessage[] }),
});

export function setRewindSession(transcriptPath: string): void {
  cacheManager.setSession(transcriptPath);
}

/**
 * Clear ALL caches (ack, denial, rewind).
 * Called when rewind is detected.
 */
export function invalidateAllCaches(): void {
  clearAckCache();
  clearDenialCache();
  cacheManager.clear();
}

/**
 * Record a user message for future rewind detection.
 * Call this after reading the transcript in pre-tool-use hook.
 *
 * @param msg - The user message content
 * @param index - The transcript line index
 */
export function recordUserMessage(msg: string, index: number): void {
  if (!msg) return;

  const data = cacheManager.load();
  const hash = hashString(msg);
  const snippet = msg.slice(0, 100);

  // Check if this message is already cached (avoid duplicates)
  const exists = data.userMessages.some((m) => m.hash === hash);
  if (exists) return;

  // Add new message with timestamp
  data.userMessages.push({ hash, snippet, index, timestamp: Date.now() });

  // Reset first response flag when a new unique user message is added.
  // After pushing, length-2 is the previous last message (before we added this one).
  // If there was no previous message or it differs from current, reset the flag.
  const previousMessage = data.userMessages[data.userMessages.length - 2];
  if (!previousMessage || previousMessage.hash !== hash) {
    data.firstResponseChecked = false;
  }

  cacheManager.save(data);
}

/**
 * Detect if a rewind has occurred by checking if cached user messages
 * still exist in the transcript.
 *
 * @param transcriptPath - Path to the transcript file
 * @returns true if rewind detected (caches cleared), false otherwise
 */
export async function detectRewind(transcriptPath: string): Promise<boolean> {
  const data = cacheManager.load();

  // No cached messages - nothing to detect
  if (data.userMessages.length === 0) {
    return false;
  }

  // Read transcript content
  let transcriptContent: string;
  try {
    transcriptContent = await fs.promises.readFile(transcriptPath, "utf-8");
  } catch {
    // Can't read transcript - don't invalidate
    return false;
  }

  // Check if ANY cached message is missing from transcript
  for (const cached of data.userMessages) {
    if (!transcriptContent.includes(cached.snippet)) {
      logToHomeAssistant({
        agent: "rewind-cache",
        level: "info",
        problem: "Rewind detected",
        answer: `Missing message: "${cached.snippet.slice(0, 50)}..."`,
      });

      invalidateAllCaches();
      return true;
    }
  }

  return false;
}

/**
 * Check if first response intent has already been checked for this user turn.
 */
export function isFirstResponseChecked(): boolean {
  const data = cacheManager.load();
  return data.firstResponseChecked;
}

/**
 * Mark first response intent as checked for this user turn.
 */
export function markFirstResponseChecked(): void {
  cacheManager.update((data) => ({ ...data, firstResponseChecked: true }));
}

/**
 * Reset the first response flag (called on rewind or new user message).
 */
export function resetFirstResponseFlag(): void {
  cacheManager.update((data) => ({ ...data, firstResponseChecked: false }));
}
