import type { SessionState } from "../../utils/session-store.js";
import type { AppealUserState } from "../../rules/types.js";

export function buildAppealUserState(state: SessionState): AppealUserState {
  const p = state.currentPrediction;
  return {
    mood: p?.mood ?? null,
    trust: p?.trust ?? null,
    frustrationStreak: state.frustrationStreak,
    userMessageSnippet: p?.userMessageSnippet ?? "",
    intent: p?.intent ?? "",
    blockedIntent: p?.blockedIntent ?? "",
    blockAllTools: p?.blockAllTools ?? false,
    explicitlyAllowedTools: p?.explicitlyAllowedTools ?? [],
    explicitlyBlockedSubstrings: p?.explicitlyBlockedSubstrings ?? [],
  };
}
