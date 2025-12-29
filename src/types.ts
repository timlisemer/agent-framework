export type ModelTier = 'haiku' | 'sonnet' | 'opus';

// Model IDs defined ONCE here. Update when Anthropic releases new versions.
export const MODEL_IDS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-5-20251101"
};

export function getModelId(tier: ModelTier): string {
  return MODEL_IDS[tier];
}

export interface AgentResult {
  success: boolean;
  output: string;
}

// Off-topic / conversation alignment check result
export interface OffTopicCheckResult {
  decision: 'OK' | 'INTERVENE';
  feedback?: string;
}

export interface UserMessage {
  text: string;
  messageIndex: number;
}

export interface AssistantMessage {
  text: string;
  messageIndex: number;
}

export interface ConversationContext {
  userMessages: UserMessage[];
  assistantMessages: AssistantMessage[];
  conversationSummary: string;
  lastAssistantMessage: string;
}

// Legacy types kept for backwards compatibility
export interface IntentValidationResult {
  decision: 'ALLOW' | 'WARN' | 'BLOCK';
  reason?: string;
}

export interface IntentContext {
  userMessages: UserMessage[];
  fullIntent: string;
}
