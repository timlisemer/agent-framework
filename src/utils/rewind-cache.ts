import * as fs from "fs";
import * as crypto from "crypto";
import { clearAckCache } from "./ack-cache.js";
import { logToHomeAssistant } from "./logger.js";

const REWIND_CACHE_FILE = "/tmp/claude-rewind-cache.json";
const DENIAL_CACHE_FILE = "/tmp/claude-hook-denials.json";
const MAX_CACHED_MESSAGES = 20; // Keep last N user messages

interface CachedUserMessage {
  hash: string; // MD5 first 8 chars
  snippet: string; // First 100 chars for transcript search
  index: number; // Transcript line when captured
}

interface RewindCache {
  sessionId: string;
  userMessages: CachedUserMessage[];
  firstResponseChecked: boolean;
  lastUserMessageHash: string;
}

// Current session ID, set via setRewindSession()
let currentSessionId: string | undefined;

function hashMessage(msg: string): string {
  return crypto.createHash("md5").update(msg).digest("hex").slice(0, 8);
}

export function setRewindSession(transcriptPath: string): void {
  currentSessionId = transcriptPath;
}

function loadRewindCache(): RewindCache {
  try {
    if (fs.existsSync(REWIND_CACHE_FILE)) {
      const data = JSON.parse(
        fs.readFileSync(REWIND_CACHE_FILE, "utf-8")
      ) as RewindCache;

      // Clear cache if session changed (new Claude Code session)
      if (
        currentSessionId &&
        data.sessionId &&
        data.sessionId !== currentSessionId
      ) {
        return {
          sessionId: currentSessionId,
          userMessages: [],
          firstResponseChecked: false,
          lastUserMessageHash: "",
        };
      }

      data.sessionId = currentSessionId || "";
      return data;
    }
  } catch {
    // Ignore errors, return empty cache
  }
  return {
    sessionId: currentSessionId || "",
    userMessages: [],
    firstResponseChecked: false,
    lastUserMessageHash: "",
  };
}

function saveRewindCache(cache: RewindCache): void {
  try {
    fs.writeFileSync(REWIND_CACHE_FILE, JSON.stringify(cache));
  } catch {
    // Ignore write errors
  }
}

function clearDenialCache(): void {
  try {
    if (fs.existsSync(DENIAL_CACHE_FILE)) {
      fs.unlinkSync(DENIAL_CACHE_FILE);
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Clear ALL caches (ack, denial, rewind).
 * Called when rewind is detected.
 */
export function invalidateAllCaches(): void {
  clearAckCache();
  clearDenialCache();
  try {
    if (fs.existsSync(REWIND_CACHE_FILE)) {
      fs.unlinkSync(REWIND_CACHE_FILE);
    }
  } catch {
    // Ignore errors
  }
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

  const cache = loadRewindCache();
  const hash = hashMessage(msg);
  const snippet = msg.slice(0, 100);

  // Check if this message is already cached (avoid duplicates)
  const exists = cache.userMessages.some((m) => m.hash === hash);
  if (exists) return;

  // Add new message
  cache.userMessages.push({ hash, snippet, index });

  // Keep only last N messages
  if (cache.userMessages.length > MAX_CACHED_MESSAGES) {
    cache.userMessages = cache.userMessages.slice(-MAX_CACHED_MESSAGES);
  }

  // Update last user message hash for first-response tracking
  const currentHash = hash;
  if (cache.lastUserMessageHash !== currentHash) {
    // New user message - reset first response flag
    cache.firstResponseChecked = false;
    cache.lastUserMessageHash = currentHash;
  }

  saveRewindCache(cache);
}

/**
 * Detect if a rewind has occurred by checking if cached user messages
 * still exist in the transcript.
 *
 * @param transcriptPath - Path to the transcript file
 * @returns true if rewind detected (caches cleared), false otherwise
 */
export async function detectRewind(transcriptPath: string): Promise<boolean> {
  const cache = loadRewindCache();

  // No cached messages - nothing to detect
  if (cache.userMessages.length === 0) {
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
  for (const cached of cache.userMessages) {
    // Search for the snippet in the transcript
    if (!transcriptContent.includes(cached.snippet)) {
      // Message not found - rewind detected!
      logToHomeAssistant({
        agent: "rewind-cache",
        level: "info",
        problem: "Rewind detected",
        answer: `Missing message: "${cached.snippet.slice(0, 50)}..."`,
      });

      // Clear all caches
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
  const cache = loadRewindCache();
  return cache.firstResponseChecked;
}

/**
 * Mark first response intent as checked for this user turn.
 */
export function markFirstResponseChecked(): void {
  const cache = loadRewindCache();
  cache.firstResponseChecked = true;
  saveRewindCache(cache);
}

/**
 * Reset the first response flag (called on rewind or new user message).
 */
export function resetFirstResponseFlag(): void {
  const cache = loadRewindCache();
  cache.firstResponseChecked = false;
  saveRewindCache(cache);
}
