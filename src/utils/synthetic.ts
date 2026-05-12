import * as fs from "fs";
import { getSessionDir, appendToolLog } from "./session-store.js";

type MessageKind = "user" | "ai" | "tool";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export function formatTodoState(todos: TodoItem[]): string {
  const inProgress = todos.filter((t) => t.status === "in_progress");
  const pending = todos.filter((t) => t.status === "pending");
  const completed = todos.filter((t) => t.status === "completed");

  const lines: string[] = [];

  if (inProgress.length > 0) {
    lines.push("In Progress:");
    inProgress.forEach((t) => lines.push(`  - ${t.content}`));
  }
  if (pending.length > 0) {
    lines.push("Pending:");
    pending.forEach((t) => lines.push(`  - ${t.content}`));
  }
  if (completed.length > 0) {
    lines.push("Completed:");
    completed.forEach((t) => lines.push(`  - ${t.content}`));
  }

  return lines.join("\n");
}

export function extractAskUserAnswer(toolResponse: unknown): string | null {
  if (typeof toolResponse === "string" && toolResponse.trim()) {
    return toolResponse;
  }
  if (toolResponse && typeof toolResponse === "object") {
    const resp = toolResponse as Record<string, unknown>;
    if (typeof resp.answer === "string") return resp.answer;
    if (typeof resp.text === "string") return resp.text;
    if (typeof resp.content === "string") return resp.content;
    if (typeof resp.result === "string") return resp.result;
  }
  return null;
}

function buildEntry(kind: MessageKind, source: string, content: string): object {
  switch (kind) {
    case "user":
      return { message: { role: "user", content } };
    case "ai":
      return { message: { role: "assistant", content: [{ type: "text", text: content }] } };
    case "tool":
      return { message: { role: "user", content: [{ type: "tool_result", content: `[${source}] ${content}` }] } };
  }
}

async function writeSynthetic(
  transcriptPath: string,
  _sessionId: string,
  kind: MessageKind,
  source: string,
  content: string
): Promise<void> {
  // 1. Write to transcript
  const entry = buildEntry(kind, source, content);
  await fs.promises.appendFile(transcriptPath, JSON.stringify(entry) + "\n");

  // 2. Append to tool log
  const sessionDir = getSessionDir(transcriptPath);
  await appendToolLog(sessionDir, {
    ts: Date.now(),
    tool: "Synthetic",
    status: "allowed",
    gate: source,
    reason: content.slice(0, 200),
    ms: 0,
  });
}

export async function writeUser(
  transcriptPath: string,
  sessionId: string,
  source: string,
  content: string
): Promise<void> {
  return writeSynthetic(transcriptPath, sessionId, "user", source, content);
}

export async function writeTool(
  transcriptPath: string,
  sessionId: string,
  source: string,
  content: string
): Promise<void> {
  return writeSynthetic(transcriptPath, sessionId, "tool", source, content);
}
