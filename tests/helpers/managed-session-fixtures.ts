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
  writeJsonl(input.filePath, entries);
}
