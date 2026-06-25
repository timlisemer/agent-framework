import { writeJsonl } from "../../src/utils/file-io.js";

export function writeManagedCodexTranscript(input: {
  filePath: string;
  projectDir: string;
  threadId?: string;
  userText?: string;
  assistantText?: string;
  userTimestamp?: string;
  assistantTimestamp?: string;
  largeMiddleBytes?: number;
  toolCall?: {
    callId?: string;
    name?: string;
    namespace?: string;
    toolArguments?: unknown;
    toolInput?: unknown;
    output?: unknown;
    outputStatus?: string;
    outputError?: unknown;
    callTimestamp?: string;
    outputTimestamp?: string;
    custom?: boolean;
  };
}): void {
  const threadId = input.threadId ?? "codex-thread";
  const entries: unknown[] = [
    {
      type: "session_meta",
      timestamp: "2026-06-20T10:00:00.000Z",
      payload: { cwd: input.projectDir, id: threadId },
    },
  ];
  if (input.largeMiddleBytes && input.largeMiddleBytes > 0) {
    entries.push({ payload: { note: "x".repeat(input.largeMiddleBytes) } });
  }
  entries.push(
    {
      timestamp: input.userTimestamp ?? "2026-06-20T10:02:00.000Z",
      payload: { role: "user", text: input.userText ?? "Resume this" },
    },
    {
      timestamp: input.assistantTimestamp ?? "2026-06-20T10:03:00.000Z",
      payload: {
        role: "assistant",
        content: [{ type: "text", text: input.assistantText ?? "Ready." }],
      },
    }
  );
  if (input.toolCall) {
    const callId = input.toolCall.callId ?? "call-1";
    const callPayload: Record<string, unknown> = {
      type: input.toolCall.custom ? "custom_tool_call" : "function_call",
      call_id: callId,
      name: input.toolCall.name ?? "exec_command",
    };
    if (input.toolCall.namespace) callPayload.namespace = input.toolCall.namespace;
    if (input.toolCall.toolInput !== undefined) {
      callPayload.input = input.toolCall.toolInput;
    } else {
      callPayload.arguments = input.toolCall.toolArguments ?? {};
    }
    entries.push({
      type: "response_item",
      timestamp: input.toolCall.callTimestamp ?? "2026-06-20T10:04:00.000Z",
      payload: callPayload,
    });
    if (input.toolCall.output !== undefined) {
      entries.push({
        type: "response_item",
        timestamp: input.toolCall.outputTimestamp ?? "2026-06-20T10:05:00.000Z",
        payload: {
          type: input.toolCall.custom ? "custom_tool_call_output" : "function_call_output",
          call_id: callId,
          output: input.toolCall.output,
          ...(input.toolCall.outputStatus ? { status: input.toolCall.outputStatus } : {}),
          ...(input.toolCall.outputError !== undefined ? { error: input.toolCall.outputError } : {}),
        },
      });
    }
  }
  writeJsonl(input.filePath, entries);
}
