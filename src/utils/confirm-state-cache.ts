/**
 * Confirm State Cache - Tracks when confirm agent returns DECLINED
 *
 * This cache prevents the AI from bypassing confirm's DECLINED decision
 * by calling commit again while the slash command is still in the transcript.
 *
 * ## Problem Solved
 *
 * Without this cache:
 * 1. User invokes /push (slash command)
 * 2. AI calls confirm → DECLINED (issues found)
 * 3. AI calls commit AGAIN
 * 4. STEP 3b finds /push still in transcript → OVERTURN → ALLOWED (BUG!)
 *
 * With this cache:
 * - After confirm DECLINED, recordConfirmDeclined() is called
 * - Before allowing commit, checkConfirmDeclined() blocks if DECLINED
 * - Cache is cleared when user sends a new message (fresh context)
 *
 * @module confirm-state-cache
 */

import { CacheManager, getTempFilePath } from "./cache-manager.js";

const CONFIRM_STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Represents a confirm agent's DECLINED state.
 */
export interface ConfirmState {
  declined: boolean;
  reason: string;
  timestamp: number;
}

interface ConfirmStateData {
  entries: ConfirmState[];
}

const cacheManager = new CacheManager<ConfirmStateData>({
  filePath: getTempFilePath("confirm-state.json"),
  defaultData: () => ({ entries: [] }),
  expiryMs: CONFIRM_STATE_EXPIRY_MS,
  maxEntries: 1,
  getTimestamp: (e) => (e as ConfirmState).timestamp,
  getEntries: (d) => d.entries,
  setEntries: (d, e) => ({ ...d, entries: e as ConfirmState[] }),
});

/**
 * Set the session for confirm state cache isolation.
 * Call this at the start of each hook invocation to ensure
 * subagent states don't bleed into the main session.
 *
 * @param transcriptPath - Path to the transcript file (used as session ID)
 */
export function setConfirmStateSession(transcriptPath: string): void {
  cacheManager.setSession(transcriptPath);
}

/**
 * Record that confirm agent returned DECLINED.
 * Called from confirm.ts when it returns a DECLINED result.
 *
 * @param reason - The reason confirm declined (for display to user)
 */
export async function recordConfirmDeclined(reason: string): Promise<void> {
  const state: ConfirmState = {
    declined: true,
    reason,
    timestamp: Date.now(),
  };

  await cacheManager.update(() => ({ entries: [state] }));
}

/**
 * Check if confirm agent has DECLINED in the current session.
 * Called from pre-tool-use.ts before allowing commit via slash command.
 *
 * @returns Object with declined status and reason if declined
 */
export async function checkConfirmDeclined(): Promise<{
  declined: boolean;
  reason?: string;
}> {
  const data = await cacheManager.load();
  const state = data.entries[0];

  if (!state || !state.declined) {
    return { declined: false };
  }

  return {
    declined: true,
    reason: state.reason,
  };
}

/**
 * Clear the confirm state cache.
 * Called when:
 * - User sends a new message (fresh context)
 * - Commit succeeds (confirm was implicitly re-approved)
 * - User explicitly re-invokes a slash command
 */
export async function clearConfirmState(): Promise<void> {
  await cacheManager.update(() => ({ entries: [] }));
}
