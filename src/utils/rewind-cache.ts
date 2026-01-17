import * as fs from "fs";
import { CacheManager, getTempFilePath } from "./cache-manager.js";
import { hashString } from "./hash-utils.js";
import { clearAckCache } from "./ack-cache.js";
import { clearDenialCache } from "./denial-cache.js";

const REWIND_CACHE_FILE = getTempFilePath("rewind-cache.json");
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
  checkedMessageHashes: Record<string, string[]>;
}

const cacheManager = new CacheManager<RewindData>({
  filePath: REWIND_CACHE_FILE,
  defaultData: () => ({ userMessages: [], firstResponseChecked: false, checkedMessageHashes: {} }),
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
export async function invalidateAllCaches(): Promise<void> {
  await clearAckCache();
  await clearDenialCache();
  await cacheManager.clear();
}

/**
 * Record a user message for future rewind detection.
 * Call this after reading the transcript in pre-tool-use hook.
 *
 * @param msg - The user message content
 * @param index - The transcript line index
 */
export async function recordUserMessage(msg: string, index: number): Promise<void> {
  if (!msg) return;

  const data = await cacheManager.load();
  const hash = hashString(msg);
  const snippet = msg.slice(0, 100);

  // Check if this message is already cached (avoid duplicates)
  const exists = data.userMessages.some((m) => m.hash === hash);
  if (exists) return;

  // Add new message with timestamp
  data.userMessages.push({ hash, snippet, index, timestamp: Date.now() });

  // Reset first response flag when a new unique user message is added.
  // Since we already checked for duplicates above, this is always a new message.
  data.firstResponseChecked = false;

  await cacheManager.save(data);
}

/**
 * Detect if a rewind has occurred by checking if cached user messages
 * still exist in the transcript.
 *
 * @param transcriptPath - Path to the transcript file
 * @returns true if rewind detected (caches cleared), false otherwise
 */
export async function detectRewind(transcriptPath: string): Promise<boolean> {
  const data = await cacheManager.load();

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
      await invalidateAllCaches();
      return true;
    }
  }

  return false;
}

/**
 * Check if first response intent has already been checked for this user turn.
 */
export async function isFirstResponseChecked(): Promise<boolean> {
  const data = await cacheManager.load();
  return data.firstResponseChecked;
}

/**
 * Mark first response intent as checked for this user turn.
 */
export async function markFirstResponseChecked(): Promise<void> {
  await cacheManager.update((data) => ({ ...data, firstResponseChecked: true }));
}

/**
 * Reset the first response flag (called on rewind or new user message).
 */
export async function resetFirstResponseFlag(): Promise<void> {
  await cacheManager.update((data) => ({ ...data, firstResponseChecked: false }));
}

/**
 * Check if transcript has a new user message that isn't cached yet.
 * Used by lazy path to detect user interrupts during parallel tool calls.
 *
 * @param transcriptPath - Path to the transcript file
 * @returns true if new user message detected (firstResponseChecked reset), false otherwise
 */
export async function hasNewUserMessage(transcriptPath: string): Promise<boolean> {
  const data = await cacheManager.load();

  // Read transcript to find last user message
  let transcriptContent: string;
  try {
    transcriptContent = await fs.promises.readFile(transcriptPath, "utf-8");
  } catch {
    return false;
  }

  // Find last USER: line in transcript
  const lines = transcriptContent.split("\n");
  let lastUserContent = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("USER:")) {
      // Collect multi-line user message
      lastUserContent = lines[i].substring(5).trim();
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith("ASSISTANT:") || lines[j].startsWith("TOOL_CALL:") || lines[j].startsWith("TOOL_RESULT:")) {
          break;
        }
        lastUserContent += "\n" + lines[j];
      }
      break;
    }
  }

  if (!lastUserContent) return false;

  // Check if this message is already cached
  const msgHash = hashString(lastUserContent);
  const isCached = data.userMessages.some((m) => m.hash === msgHash);

  if (!isCached) {
    // New user message! Reset firstResponseChecked so strict path runs
    await cacheManager.update((d) => ({ ...d, firstResponseChecked: false }));
    return true;
  }

  return false;
}

/**
 * Check if a user message has already been processed by a specific agent.
 * Uses content hash for parallel-safe coordination.
 *
 * @param agentName - The agent name (e.g., "response-align", "error-acknowledge")
 * @param messageContent - The user message content to check
 * @returns true if this message was already checked by this agent
 */
export async function isMessageCheckedByAgent(
  agentName: string,
  messageContent: string
): Promise<boolean> {
  const data = await cacheManager.load();
  const hash = hashString(messageContent);
  const agentHashes = data.checkedMessageHashes[agentName] || [];
  return agentHashes.includes(hash);
}

/**
 * Mark a user message as checked by a specific agent.
 * Atomic add - safe for parallel tool calls.
 *
 * @param agentName - The agent name (e.g., "response-align", "error-acknowledge")
 * @param messageContent - The user message content to mark as checked
 */
export async function markMessageCheckedByAgent(
  agentName: string,
  messageContent: string
): Promise<void> {
  const hash = hashString(messageContent);
  await cacheManager.update((data) => {
    const agentHashes = data.checkedMessageHashes[agentName] || [];
    if (!agentHashes.includes(hash)) {
      return {
        ...data,
        checkedMessageHashes: {
          ...data.checkedMessageHashes,
          [agentName]: [...agentHashes, hash],
        },
      };
    }
    return data;
  });
}
