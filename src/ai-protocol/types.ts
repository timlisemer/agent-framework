export type SessionId = string;
export type TurnId = string;
export type AiMessageId = string;
export type ToolCallId = string;
export type AiBackendProcessId = string;
export type AiEventSeq = number;
export type AiSnapshotRevision = number;

export type AiPlanMode = "disabled" | "planning" | "awaitingApproval" | "approved";
export type AiMessageRole = "user" | "assistant" | "system" | "tool";
export type AiMessageStatus = "streaming" | "completed" | "failed" | "cancelled";
export type AiSessionStatus = "idle" | "running" | "waiting" | "error" | "cancelled";
export type AiToolStatus =
  | "created"
  | "waiting"
  | "delayed"
  | "approved"
  | "denied"
  | "unsupported"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type AiBackendProcessStatus = "created" | "running" | "completed" | "failed" | "cancelled";

export type TokenUsage = {
  promptTokens: number | null;
  cachedTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

export type AiContentBlock =
  | { type: "text"; text: string }
  | { type: "error"; message: string };

export type AiMessage = {
  role: AiMessageRole;
  content: AiContentBlock[];
};

export type AiTranscriptEntry = {
  id: AiMessageId;
  turnId: TurnId | null;
  role: AiMessageRole;
  content: AiContentBlock[];
  status: AiMessageStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  usage: TokenUsage | null;
};

export type AiWaitState = {
  reason: string | null;
  since: string;
} | null;

export type AiToolInputSummary = {
  text: string;
  fields?: Record<string, string | number | boolean | null>;
};

export type AiToolOutputBlock =
  | { type: "text"; text: string }
  | { type: "json"; value: unknown };

export type AiErrorInfo = {
  code: "cancelled" | "invalid_request" | "not_found" | "conflict" | "runtime_error";
  message: string;
  recoverable: boolean;
};

export type AiToolResult = {
  state: "completed" | "failed" | "denied" | "cancelled" | "unsupported" | "movedToProcess";
  output: AiToolOutputBlock[];
  error: AiErrorInfo | null;
};

export type AiToolCall = {
  id: ToolCallId;
  turnId: TurnId;
  name: string;
  input: AiToolInputSummary;
  status: AiToolStatus;
  wait: AiWaitState;
  output: AiToolOutputBlock[];
  result: AiToolResult | null;
  processId: AiBackendProcessId | null;
  progress: string | null;
  elapsedMs: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type AiBackendProcess = {
  id: AiBackendProcessId;
  turnId: TurnId;
  title: string;
  status: AiBackendProcessStatus;
  progress: string | null;
  output: AiToolOutputBlock[];
  error: AiErrorInfo | null;
  cancellable: boolean;
  elapsedMs: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type AiContinuationState = {
  enabled: boolean;
  available: boolean;
  updatedAt: string | null;
};

export type AiPlanState = {
  mode: AiPlanMode;
  planText: string | null;
  approved: boolean;
};

export type AiSessionConfig = {
  model: string | null;
  workingDir: string | null;
  systemPrompt: string | null;
  continuable: boolean;
};

export type AiSessionSnapshot = {
  sessionId: SessionId;
  status: AiSessionStatus;
  revision: AiSnapshotRevision;
  lastEventSeq: AiEventSeq;
  transcript: AiTranscriptEntry[];
  toolCalls: AiToolCall[];
  backendProcesses: AiBackendProcess[];
  plan: AiPlanState;
  continuation: AiContinuationState;
  errors: AiErrorInfo[];
  error: AiErrorInfo | null;
};

export type AiToolDecision = {
  toolCallId: ToolCallId;
  decision: "approve" | "deny";
  reason: string | null;
};

export type AiRequest =
  | { type: "startSession"; sessionId: SessionId; config: AiSessionConfig }
  | { type: "sendInput"; sessionId: SessionId; turnId: TurnId; input: string }
  | { type: "submitToolDecision"; sessionId: SessionId; turnId: TurnId; decision: AiToolDecision }
  | { type: "setPlanState"; sessionId: SessionId; state: AiPlanState }
  | { type: "getSessionSnapshot"; sessionId: SessionId }
  | { type: "eventsSince"; sessionId: SessionId; afterSeq: AiEventSeq };

export type AiResponse =
  | { type: "sessionStarted"; sessionId: SessionId; snapshot: AiSessionSnapshot }
  | { type: "sessionSnapshot"; sessionId: SessionId; snapshot: AiSessionSnapshot }
  | { type: "sessionEvents"; sessionId: SessionId; events: AiEvent[]; snapshot: AiSessionSnapshot }
  | { type: "accepted"; sessionId: SessionId; turnId: TurnId | null }
  | { type: "error"; sessionId: SessionId | null; message: string; error: AiErrorInfo };

type AiEventBase = {
  sessionId: SessionId;
  seq: AiEventSeq;
  createdAt: string;
};

export type AiEvent =
  | (AiEventBase & { type: "sessionUpdated"; snapshot: AiSessionSnapshot })
  | (AiEventBase & { type: "turnStarted"; turnId: TurnId })
  | (AiEventBase & { type: "messageCreated"; turnId: TurnId; message: AiTranscriptEntry })
  | (AiEventBase & { type: "messageDelta"; turnId: TurnId; messageId: AiMessageId; delta: string })
  | (AiEventBase & { type: "messageCompleted"; turnId: TurnId; message: AiTranscriptEntry; usage: TokenUsage | null })
  | (AiEventBase & { type: "toolCallCreated"; turnId: TurnId; toolCall: AiToolCall })
  | (AiEventBase & { type: "toolCallUpdated"; turnId: TurnId; toolCall: AiToolCall })
  | (AiEventBase & { type: "toolCallProgress"; turnId: TurnId; toolCallId: ToolCallId; progress: string | null; elapsedMs: number | null })
  | (AiEventBase & { type: "toolCallOutput"; turnId: TurnId; toolCallId: ToolCallId; output: AiToolOutputBlock[] })
  | (AiEventBase & { type: "backendProcessCreated"; turnId: TurnId; process: AiBackendProcess })
  | (AiEventBase & { type: "backendProcessUpdated"; turnId: TurnId; process: AiBackendProcess })
  | (AiEventBase & { type: "backendProcessProgress"; turnId: TurnId; processId: AiBackendProcessId; progress: string | null; elapsedMs: number | null })
  | (AiEventBase & { type: "toolCallPromotedToBackendProcess"; turnId: TurnId; toolCallId: ToolCallId; processId: AiBackendProcessId })
  | (AiEventBase & { type: "continuationUpdated"; continuation: AiContinuationState })
  | (AiEventBase & { type: "planStateChanged"; state: AiPlanState })
  | (AiEventBase & { type: "turnFinished"; turnId: TurnId; usage: TokenUsage | null })
  | (AiEventBase & { type: "error"; turnId: TurnId | null; error: AiErrorInfo; message: string });

export type AiBackendMessage =
  | { type: "response"; response: AiResponse }
  | { type: "event"; event: AiEvent };

export type AiClientMessage =
  | { type: "request"; request: AiRequest }
  | { type: "cancel"; sessionId: SessionId; turnId: TurnId | null };
