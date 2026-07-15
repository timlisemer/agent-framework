import type { AdapterToolContinuation } from "../adapter/types.js";
import { getSessionState } from "./session-store.js";
import {
  requireToolSequenceNext,
  toolContinuationRequirement,
} from "./prediction-types.js";

export async function requireAdapterToolContinuation(
  sessionDir: string,
  continuation: AdapterToolContinuation | null,
  fallback: { intent: string; userMessage: string },
): Promise<void> {
  const requirement = toolContinuationRequirement(continuation);
  if (!requirement) return;

  await getSessionState(sessionDir).update((state) => ({
    ...state,
    currentPrediction: requireToolSequenceNext(
      state.currentPrediction,
      [requirement],
      fallback,
    ),
  }));
}
