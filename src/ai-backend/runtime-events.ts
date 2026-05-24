import type {
  AiBackendProcessStatus,
  AiPlanState,
  AiSessionConfig,
  AiToolInputSummary,
  AiToolOutputBlock,
  AiToolStatus,
  TokenUsage,
  TurnId,
} from "../ai-protocol/index.js";

export type RuntimeRef = string;

export type AiRuntimeEvent =
  | { type: "message.created"; ref?: RuntimeRef; role?: "assistant"; content?: string; createdAt?: string }
  | { type: "message.delta"; ref?: RuntimeRef; delta: string; createdAt?: string }
  | { type: "message.reasoning_delta"; ref?: RuntimeRef; delta: string; createdAt?: string }
  | { type: "message.completed"; ref?: RuntimeRef; content?: string; usage?: TokenUsage | null; createdAt?: string }
  | { type: "message.failed"; ref?: RuntimeRef; error: unknown; createdAt?: string }
  | { type: "tool.created"; ref: RuntimeRef; name: string; input: AiToolInputSummary; createdAt?: string }
  | { type: "tool.updated"; ref: RuntimeRef; status: AiToolStatus; waitReason?: string | null; createdAt?: string }
  | { type: "tool.progress"; ref: RuntimeRef; progress: string | null; createdAt?: string }
  | { type: "tool.output"; ref: RuntimeRef; output: AiToolOutputBlock[]; createdAt?: string }
  | { type: "tool.completed"; ref: RuntimeRef; output?: AiToolOutputBlock[]; usage?: TokenUsage | null; createdAt?: string }
  | { type: "tool.failed"; ref: RuntimeRef; error: unknown; createdAt?: string }
  | { type: "tool.cancelled"; ref: RuntimeRef; createdAt?: string }
  | { type: "backend_process.created"; ref: RuntimeRef; title: string; cancellable?: boolean; createdAt?: string }
  | { type: "backend_process.updated"; ref: RuntimeRef; status: AiBackendProcessStatus; createdAt?: string }
  | { type: "backend_process.progress"; ref: RuntimeRef; progress: string | null; createdAt?: string }
  | { type: "backend_process.output"; ref: RuntimeRef; output: AiToolOutputBlock[]; createdAt?: string }
  | { type: "backend_process.completed"; ref: RuntimeRef; output?: AiToolOutputBlock[]; usage?: TokenUsage | null; createdAt?: string }
  | { type: "backend_process.failed"; ref: RuntimeRef; error: unknown; createdAt?: string }
  | { type: "backend_process.cancelled"; ref: RuntimeRef; createdAt?: string }
  | { type: "tool.promoted_to_backend_process"; toolRef: RuntimeRef; processRef: RuntimeRef; title: string; createdAt?: string }
  | { type: "continuation.updated"; available: boolean; createdAt?: string }
  | { type: "plan.updated"; state: AiPlanState; createdAt?: string }
  | { type: "turn.completed"; usage?: TokenUsage | null; createdAt?: string }
  | { type: "error"; error: unknown; createdAt?: string };

export type AiRunTurnInput = {
  config: AiSessionConfig;
  prompt: string;
  turnId: TurnId;
  signal: AbortSignal;
};
