import {
  AI_ERROR_CODES,
  AI_MESSAGE_ROLES,
  AI_MESSAGE_STATUSES,
  AI_TOOL_RESULT_STATES,
  AI_TOOL_STATUSES,
} from "./constants.js";

export type SessionId = string;
export type TurnId = string;
export type AiMessageId = string;
export type ToolCallId = string;
export type AiBackendProcessId = string;
export type AiRequestId = string;
export type AiEventSeq = number;
export type AiTimelineSeq = number;
export type AiSnapshotRevision = number;

export type AiPlanMode = "disabled" | "planning" | "awaitingApproval" | "approved";
export type SdkRuntimeEnvironment = "isolated" | "user";
export type SdkRuntimeHome = "native" | "managedAstral";
export type AiMessageRole = (typeof AI_MESSAGE_ROLES)[number];
export type AiMessageStatus = (typeof AI_MESSAGE_STATUSES)[number];
export type AiSessionStatus = "idle" | "running" | "waiting" | "error" | "cancelled";
export type AiToolStatus = (typeof AI_TOOL_STATUSES)[number];
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
  | { type: "reasoning"; text: string }
  | { type: "error"; message: string; metadata?: AiMetadata };

export type AiMessage = {
  role: AiMessageRole;
  content: AiContentBlock[];
};

export type AiTranscriptEntry = {
  id: AiMessageId;
  sequenceId: AiTimelineSeq;
  turnId: TurnId | null;
  role: AiMessageRole;
  content: AiContentBlock[];
  status: AiMessageStatus;
  metadata?: AiMetadata;
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

export type AiMetadataValue =
  | string
  | number
  | boolean
  | null
  | AiMetadataValue[]
  | { [key: string]: AiMetadataValue };

export type AiMetadata = Record<string, AiMetadataValue>;

export type AiErrorInfo = {
  code: (typeof AI_ERROR_CODES)[number];
  message: string;
  recoverable: boolean;
  metadata?: AiMetadata;
};

export type AiToolResult = {
  state: (typeof AI_TOOL_RESULT_STATES)[number];
  output: AiToolOutputBlock[];
  error: AiErrorInfo | null;
};

export type AiToolCall = {
  id: ToolCallId;
  sequenceId: AiTimelineSeq;
  turnId: TurnId;
  name: string;
  input: AiToolInputSummary;
  status: AiToolStatus;
  metadata?: AiMetadata;
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

export type AiProviderModelChoice = {
  tier: string;
  id: string;
  displayName: string | null;
};

export type AiProviderContextState = {
  usedTokens: number | null;
  maxTokens: number | null;
  remainingTokens: number | null;
};

export type AiProviderCompactionState = {
  lastCompactedAt: string | null;
  events: AiMetadata[];
};

export type AiProviderMetadataState = {
  provider: string | null;
  runtime: "claude" | "codex" | null;
  model: string | null;
  displayModel: string | null;
  availableModels: AiProviderModelChoice[];
  nativeSessionId: string | null;
  usage: TokenUsage | null;
  context: AiProviderContextState;
  compaction: AiProviderCompactionState;
  errors: AiErrorInfo[];
};

export type AiSessionConfig = {
  model: string | null;
  workingDir: string | null;
  systemPrompt: string | null;
  continuable: boolean;
  sdkRuntimeEnvironment: SdkRuntimeEnvironment;
  sdkRuntimeHome?: SdkRuntimeHome;
};

export type AiSessionChoicesConfig = {
  sdkRuntimeHome: SdkRuntimeHome;
  maxResults?: number;
};

export type AiSessionDescriptor = {
  resumeId: string;
  summary: string;
  workingDir: string;
  createdAt?: string;
  updatedAt?: string;
};

export type AiWorkingDirectoryCandidate = {
  path: string;
  sessionCount: number;
  lastUsedAt?: string;
};

export type AiSessionSnapshot = {
  sessionId: SessionId;
  workingDir: string | null;
  agentFrameworkSessionDir: string | null;
  status: AiSessionStatus;
  revision: AiSnapshotRevision;
  lastEventSeq: AiEventSeq;
  transcript: AiTranscriptEntry[];
  toolCalls: AiToolCall[];
  backendProcesses: AiBackendProcess[];
  provider: AiProviderMetadataState;
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
  | { type: "listSessionChoices"; requestId: AiRequestId; config: AiSessionChoicesConfig }
  | { type: "startSession"; sessionId: SessionId; config: AiSessionConfig }
  | { type: "resumeSession"; requestId: AiRequestId; sessionId: SessionId; resumeId: string; config: AiSessionConfig }
  | { type: "closeSession"; requestId: AiRequestId; sessionId: SessionId }
  | { type: "sendInput"; sessionId: SessionId; turnId: TurnId; input: string }
  | { type: "submitToolDecision"; sessionId: SessionId; turnId: TurnId; decision: AiToolDecision }
  | { type: "setPlanState"; sessionId: SessionId; state: AiPlanState }
  | { type: "getSessionSnapshot"; sessionId: SessionId }
  | { type: "eventsSince"; sessionId: SessionId; afterSeq: AiEventSeq };

export type AiResponse =
  | { type: "sessionStarted"; sessionId: SessionId; snapshot: AiSessionSnapshot }
  | { type: "sessionSnapshot"; sessionId: SessionId; snapshot: AiSessionSnapshot }
  | { type: "sessionEvents"; sessionId: SessionId; events: AiEvent[]; snapshot: AiSessionSnapshot }
  | { type: "sessionChoices"; requestId: AiRequestId; sessions: AiSessionDescriptor[]; workingDirectories: AiWorkingDirectoryCandidate[] }
  | { type: "sessionClosed"; requestId: AiRequestId; sessionId: SessionId }
  | { type: "requestError"; requestId: AiRequestId; sessionId?: SessionId; code: AiErrorInfo["code"]; message: string; recoverable: boolean }
  | { type: "accepted"; sessionId: SessionId; turnId: TurnId | null }
  | { type: "error"; sessionId: SessionId | null; message: string; error: AiErrorInfo };

type AiEventBase = {
  sessionId: SessionId;
  seq: AiEventSeq;
  createdAt: string;
};

export type AiEvent =
  | (AiEventBase & { type: "sessionUpdated"; snapshot: AiSessionSnapshot })
  | (AiEventBase & { type: "sessionStatusChanged"; status: AiSessionStatus; error: AiErrorInfo | null })
  | (AiEventBase & { type: "turnStarted"; turnId: TurnId })
  | (AiEventBase & { type: "messageCreated"; turnId: TurnId; message: AiTranscriptEntry })
  | (AiEventBase & { type: "messageDelta"; turnId: TurnId; messageId: AiMessageId; delta: string })
  | (AiEventBase & { type: "messageReasoningDelta"; turnId: TurnId; messageId: AiMessageId; delta: string })
  | (AiEventBase & { type: "messageCompleted"; turnId: TurnId; messageId: AiMessageId; message: AiTranscriptEntry; status: AiMessageStatus; completedAt: string; usage: TokenUsage | null; error: AiErrorInfo | null })
  | (AiEventBase & { type: "toolCallCreated"; turnId: TurnId; toolCall: AiToolCall })
  | (AiEventBase & { type: "toolCallStatusChanged"; turnId: TurnId; toolCallId: ToolCallId; status: AiToolStatus; wait: AiWaitState; resultState: AiToolResult["state"] | null; error: AiErrorInfo | null; completedAt: string | null; processId: AiBackendProcessId | null; progress: string | null; elapsedMs: number | null })
  | (AiEventBase & { type: "toolCallMetadataChanged"; turnId: TurnId; toolCallId: ToolCallId; metadata: AiMetadata })
  | (AiEventBase & { type: "toolCallOutput"; turnId: TurnId; toolCallId: ToolCallId; output: AiToolOutputBlock[] })
  | (AiEventBase & { type: "backendProcessCreated"; turnId: TurnId; process: AiBackendProcess })
  | (AiEventBase & { type: "backendProcessStatusChanged"; turnId: TurnId; processId: AiBackendProcessId; status: AiBackendProcessStatus; cancellable: boolean; error: AiErrorInfo | null; completedAt: string | null })
  | (AiEventBase & { type: "backendProcessProgress"; turnId: TurnId; processId: AiBackendProcessId; progress: string | null; elapsedMs: number | null })
  | (AiEventBase & { type: "backendProcessOutput"; turnId: TurnId; processId: AiBackendProcessId; output: AiToolOutputBlock[] })
  | (AiEventBase & { type: "continuationUpdated"; continuation: AiContinuationState })
  | (AiEventBase & { type: "planStateChanged"; state: AiPlanState })
  | (AiEventBase & { type: "turnFinished"; turnId: TurnId; usage: TokenUsage | null })
  | (AiEventBase & { type: "error"; turnId: TurnId | null; error: AiErrorInfo; message: string });

export type AiBackendMessage =
  | { type: "response"; response: AiResponse }
  | { type: "event"; event: AiEvent; snapshot: AiSessionSnapshot };

export type AiClientMessage =
  | { type: "request"; request: AiRequest }
  | { type: "cancel"; sessionId: SessionId; turnId: TurnId | null };
