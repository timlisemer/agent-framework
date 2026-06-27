import type {
  AiPlanState,
  AiProviderMetadataState,
  AiSessionConfig,
  AiToolCall,
  AiTranscriptEntry,
  TokenUsage,
  TurnId,
} from "../ai-protocol/index.js";

export type AiRuntimeEvent =
  | { type: "continuation.updated"; available: boolean; createdAt?: string }
  | { type: "plan.updated"; state: AiPlanState; createdAt?: string }
  | { type: "provider.metadata"; provider: Partial<AiProviderMetadataState>; createdAt?: string }
  | { type: "timeline.snapshot"; transcript: AiTranscriptEntry[]; toolCalls: AiToolCall[]; agentFrameworkSessionDir?: string | null; provider?: Partial<AiProviderMetadataState>; createdAt?: string }
  | { type: "turn.completed"; usage?: TokenUsage | null; createdAt?: string }
  | { type: "error"; error: unknown; createdAt?: string };

export type AiRunTurnInput = {
  config: AiSessionConfig;
  prompt: string;
  turnId: TurnId;
  signal: AbortSignal;
};
