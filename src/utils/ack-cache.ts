import * as fs from "fs";
import * as crypto from "crypto";

const ACK_CACHE_FILE = '/tmp/claude-error-acks.json';
const ACK_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

interface AckEntry {
  errorHash: string;
  errorSnippet: string;
  acknowledgedAt: number;
}

interface AckCache {
  sessionId?: string;
  lastUserMessageHash?: string;
  entries: AckEntry[];
}

// Current session ID, set via setSession()
let currentSessionId: string | undefined;

function hashError(error: string): string {
  return crypto.createHash('md5').update(error).digest('hex').slice(0, 8);
}

export function setSession(transcriptPath: string): void {
  currentSessionId = transcriptPath;
}

export function loadAckCache(): AckCache {
  try {
    if (fs.existsSync(ACK_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(ACK_CACHE_FILE, 'utf-8')) as AckCache;

      // Clear cache if session changed (new Claude Code session)
      if (currentSessionId && data.sessionId && data.sessionId !== currentSessionId) {
        return { sessionId: currentSessionId, entries: [] };
      }

      // Clean expired entries
      const now = Date.now();
      data.entries = data.entries.filter(
        (e: AckEntry) => now - e.acknowledgedAt < ACK_EXPIRY_MS
      );
      data.sessionId = currentSessionId;
      return data;
    }
  } catch {
    // Ignore errors, return empty cache
  }
  return { sessionId: currentSessionId, entries: [] };
}

export function saveAckCache(cache: AckCache): void {
  try {
    fs.writeFileSync(ACK_CACHE_FILE, JSON.stringify(cache));
  } catch {
    // Ignore write errors
  }
}

export function isErrorAcknowledged(errorSnippet: string): boolean {
  const cache = loadAckCache();
  const hash = hashError(errorSnippet);
  return cache.entries.some((e) => e.errorHash === hash);
}

export function markErrorAcknowledged(errorSnippet: string): void {
  const cache = loadAckCache();
  const hash = hashError(errorSnippet);

  // Don't duplicate
  if (cache.entries.some((e) => e.errorHash === hash)) return;

  cache.entries.push({
    errorHash: hash,
    errorSnippet: errorSnippet.slice(0, 100),
    acknowledgedAt: Date.now(),
  });
  saveAckCache(cache);
}

export function clearAckCache(): void {
  try {
    if (fs.existsSync(ACK_CACHE_FILE)) {
      fs.unlinkSync(ACK_CACHE_FILE);
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Check if user has sent a new message since last check.
 * If so, clear the ack cache (user interaction = fresh start).
 *
 * Call this at the start of pre-tool-use hook.
 */
export function checkUserInteraction(lastUserMessage: string | undefined): void {
  if (!lastUserMessage) return;

  const cache = loadAckCache();
  const currentHash = hashError(lastUserMessage);

  if (cache.lastUserMessageHash !== currentHash) {
    // New user message detected - clear all acks
    const newCache: AckCache = {
      sessionId: currentSessionId,
      lastUserMessageHash: currentHash,
      entries: [],
    };
    saveAckCache(newCache);
  }
}
