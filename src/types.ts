export type ModelTier = "haiku" | "sonnet" | "opus";

// Model IDs defined ONCE here. Update when Anthropic releases new versions.
export const MODEL_IDS: Record<ModelTier, string> = {
  haiku: 'x-ai/grok-4.1-fast',
  sonnet: 'google/gemini-3-flash-preview',
  opus: 'anthropic/claude-opus-4.5',
};

export function getModelId(tier: ModelTier): string {
  return MODEL_IDS[tier];
}

// Set SDK environment variables to use our model IDs
// This ensures internal SDK sub-agents use our configured models
process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = MODEL_IDS.haiku;
process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = MODEL_IDS.sonnet;
process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = MODEL_IDS.opus;

export interface AgentResult {
  success: boolean;
  output: string;
}

/**
 * Standard result type for hook agent checks.
 *
 * All hook agents should return this type (or an extension of it).
 */
export interface CheckResult {
  /** Whether the check passed */
  approved: boolean;
  /** Reason for denial (only present when approved=false) */
  reason?: string;
}

/**
 * Extended result type for stop hook checks.
 *
 * Adds systemMessage for injecting corrective guidance.
 */
export interface StopCheckResult extends CheckResult {
  /** System message to inject when blocking the stop */
  systemMessage?: string;
}

// Off-topic / conversation alignment check result
export interface OffTopicCheckResult {
  decision: "OK" | "INTERVENE";
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

