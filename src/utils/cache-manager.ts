import * as fs from "fs";
import * as path from "path";
import { hashString } from "./hash-utils.js";

/**
 * Base temp directory for all agent-framework cache files.
 * Using a dedicated subdirectory keeps /tmp clean.
 */
const TEMP_BASE_DIR = "/tmp/agent-framework";

/**
 * Get the path for a cache file within the agent-framework temp directory.
 * Creates the directory if it doesn't exist.
 *
 * @param filename - The cache filename (e.g., "confirm-state.json")
 * @returns Full path to the cache file
 */
export function getTempFilePath(filename: string): string {
  // Ensure directory exists (sync for simplicity at module load)
  if (!fs.existsSync(TEMP_BASE_DIR)) {
    fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });
  }
  return path.join(TEMP_BASE_DIR, filename);
}

/**
 * Generic cache state wrapper with session and user message tracking.
 */
interface CacheState<T> {
  sessionId?: string;
  lastUserMessageHash?: string;
  data: T;
}

/**
 * Configuration for a CacheManager instance.
 */
export interface CacheConfig<T> {
  /** Path to the cache file */
  filePath: string;
  /** Factory function to create default/empty data */
  defaultData: () => T;
  /** Time-based expiry in milliseconds (entries older than this are removed) */
  expiryMs?: number;
  /** Maximum number of entries to keep (oldest removed first) */
  maxEntries?: number;
  /** Function to get timestamp from an entry (required for expiryMs) */
  getTimestamp?: (entry: unknown) => number;
  /** Function to get entries array from data (required for expiryMs/maxEntries) */
  getEntries?: (data: T) => unknown[];
  /** Function to set entries array on data (required for expiryMs/maxEntries) */
  setEntries?: (data: T, entries: unknown[]) => T;
}

/**
 * Generic file-based cache manager with full feature set.
 * All operations are async and use atomic writes for safe concurrent access.
 *
 * All caches support:
 * - Session invalidation (clears on new Claude Code session)
 * - Time-based expiry (removes entries older than expiryMs)
 * - Max entries limit (keeps only newest maxEntries)
 * - User message tracking (clears on new user message)
 *
 * @example
 * ```typescript
 * interface MyEntry { id: string; timestamp: number; }
 * interface MyData { entries: MyEntry[]; }
 *
 * const cache = new CacheManager<MyData>({
 *   filePath: "/tmp/my-cache.json",
 *   defaultData: () => ({ entries: [] }),
 *   expiryMs: 60000,
 *   maxEntries: 20,
 *   getTimestamp: (e) => (e as MyEntry).timestamp,
 *   getEntries: (d) => d.entries,
 *   setEntries: (d, e) => ({ ...d, entries: e as MyEntry[] }),
 * });
 *
 * cache.setSession(transcriptPath);
 * await cache.checkUserMessage(lastUserMessage); // Clears if new message
 * const data = await cache.load();
 * ```
 */
export class CacheManager<T> {
  private sessionId?: string;
  private lastUserMessageHash?: string;
  private config: CacheConfig<T>;

  constructor(config: CacheConfig<T>) {
    this.config = config;
  }

  /**
   * Set the current session ID. Call this at the start of each hook invocation.
   * If the session changes, the cache will be cleared on next load.
   */
  setSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Check if user sent a new message. If so, clear the cache.
   * Call this after setSession() at the start of each hook invocation.
   *
   * @param userMessage - The latest user message content
   * @returns true if cache was cleared (new user message), false otherwise
   */
  async checkUserMessage(userMessage: string | undefined): Promise<boolean> {
    if (!userMessage) return false;

    const currentHash = hashString(userMessage);

    try {
      const raw = await fs.promises.readFile(this.config.filePath, "utf-8");
      const state: CacheState<T> = JSON.parse(raw);

      if (state.lastUserMessageHash && state.lastUserMessageHash !== currentHash) {
        this.lastUserMessageHash = currentHash;
        await this.clear();
        return true;
      }
    } catch {
      // File doesn't exist or is corrupted - that's fine
    }

    this.lastUserMessageHash = currentHash;
    return false;
  }

  /**
   * Load cache data from file.
   *
   * Returns default data if:
   * - File doesn't exist
   * - File is corrupted
   * - Session ID changed (new Claude Code session)
   *
   * Applies time expiry and max entries limits if configured.
   */
  async load(): Promise<T> {
    try {
      const raw = await fs.promises.readFile(this.config.filePath, "utf-8");
      const state: CacheState<T> = JSON.parse(raw);

      // Clear cache if session changed (new Claude Code session)
      if (
        this.sessionId &&
        state.sessionId &&
        state.sessionId !== this.sessionId
      ) {
        return this.config.defaultData();
      }

      // Update lastUserMessageHash from file if not set
      if (!this.lastUserMessageHash && state.lastUserMessageHash) {
        this.lastUserMessageHash = state.lastUserMessageHash;
      }

      let data = state.data;

      // Apply time expiry and max entries if configured
      if (this.config.getEntries && this.config.setEntries) {
        let entries = this.config.getEntries(data);

        // Time-based expiry
        if (this.config.expiryMs && this.config.getTimestamp) {
          const now = Date.now();
          const expiryMs = this.config.expiryMs;
          const getTimestamp = this.config.getTimestamp;
          entries = entries.filter((e) => now - getTimestamp(e) < expiryMs);
        }

        // Max entries limit (keep newest)
        if (this.config.maxEntries && entries.length > this.config.maxEntries) {
          entries = entries.slice(-this.config.maxEntries);
        }

        data = this.config.setEntries(data, entries);
      }

      return data;
    } catch {
      // File doesn't exist or is corrupted - return default
      return this.config.defaultData();
    }
  }

  /**
   * Save cache data to file with current session ID and user message hash.
   * Uses atomic write (temp file + rename) for safe concurrent access.
   */
  async save(data: T): Promise<void> {
    try {
      const state: CacheState<T> = {
        sessionId: this.sessionId,
        lastUserMessageHash: this.lastUserMessageHash,
        data,
      };
      const content = JSON.stringify(state);

      // Atomic write: write to temp file, then rename
      const tempPath = `${this.config.filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tempPath, content);
      await fs.promises.rename(tempPath, this.config.filePath);
    } catch {
      // Ignore write errors - cache is best-effort
    }
  }

  /**
   * Delete the cache file.
   */
  async clear(): Promise<void> {
    try {
      await fs.promises.unlink(this.config.filePath);
    } catch {
      // Ignore errors - file may not exist
    }
  }

  /**
   * Load, modify with callback, and save in one operation.
   * Uses load() to ensure expiry/max entries are applied consistently.
   */
  async update(fn: (data: T) => T): Promise<void> {
    try {
      const data = await this.load();
      const updated = fn(data);
      await this.save(updated);
    } catch {
      // Ignore errors - cache is best-effort
    }
  }
}
