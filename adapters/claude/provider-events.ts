import type { ScenarioCommandPayload } from "../../src/scenario/protocol/commands.js";
import { digestScenarioValue } from "../../src/scenario/protocol/digest.js";
import {
  toJsonValue as jsonValue,
  type JsonValue,
} from "../../src/scenario/protocol/common.js";
import { isRecord, recordFromUnknown, stringField } from "../../src/utils/output.js";
import { normalizeClaudeAiUsage } from "./usage.js";

export type ClaudeControlStreamState = {
  planUpdates: Set<string>;
  sessionRef: string | null;
};

export function createClaudeControlStreamState(
  sessionRef: string | null = null,
): ClaudeControlStreamState {
  return { planUpdates: new Set(), sessionRef };
}

export function recordClaudePlanUpdate(
  state: Pick<ClaudeControlStreamState, "planUpdates">,
  plan: string,
): boolean {
  if (state.planUpdates.has(plan)) return false;
  state.planUpdates.add(plan);
  return true;
}

export function claudePlanUpdateForTool(
  state: Pick<ClaudeControlStreamState, "planUpdates">,
  toolName: string,
  toolInput: Record<string, unknown>,
): ScenarioCommandPayload | null {
  if (
    toolName !== "ExitPlanMode" ||
    typeof toolInput.plan !== "string" ||
    !recordClaudePlanUpdate(state, toolInput.plan)
  ) return null;
  return {
    type: "planStateChanged",
    data: { mode: "awaitingApproval", planText: toolInput.plan, approved: false },
  };
}

export function mapClaudeControlStreamMessage(message: unknown, state: ClaudeControlStreamState): {
  events: ScenarioCommandPayload[];
  usage: ReturnType<typeof normalizeClaudeAiUsage>;
  sessionRef: string | null;
  terminal: boolean;
} {
  if (!isRecord(message)) {
    return { events: [], usage: null, sessionRef: state.sessionRef, terminal: false };
  }
  if (typeof message.session_id === "string") state.sessionRef = message.session_id;
  const events: ScenarioCommandPayload[] = [];
  let usage: ReturnType<typeof normalizeClaudeAiUsage> = null;
  let terminal = false;
  if (message.type === "assistant") {
    for (const block of providerMessageContent(message)) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      const input = recordFromUnknown(block.input);
      if (stringField(block, "name") !== "ExitPlanMode") continue;
      const planUpdate = claudePlanUpdateForTool(state, "ExitPlanMode", input);
      if (planUpdate) events.push(planUpdate);
    }
  } else if (message.type === "result") {
    terminal = true;
    usage = normalizeClaudeAiUsage(message.usage, message.modelUsage);
    const error = claudeResultError(message);
    if (error) events.push({ type: "runtimeErrorObserved", data: error });
  }
  return { events, usage, sessionRef: state.sessionRef, terminal };
}

function claudeResultError(message: Record<string, unknown>): JsonValue | null {
  const subtype = stringField(message, "subtype");
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((error): error is string => typeof error === "string" && error.trim().length > 0)
    : [];
  if (subtype === "success" && message.is_error !== true && errors.length === 0) return null;
  const description = errors.length > 0
    ? errors.join("\n")
    : subtype === "success"
      ? "Claude SDK returned a successful result marked as an error"
      : subtype
        ? `Claude SDK result failed: ${subtype}`
        : "Claude SDK returned a malformed result without a success subtype";
  return {
    code: "runtime_error",
    message: description,
    recoverable: false,
    metadata: {
      claudeResultSubtype: subtype,
      errors,
    },
  };
}

export function mapClaudeStructuredEvents(message: unknown, turnId: string): ScenarioCommandPayload[] {
  if (!isRecord(message)) return [];
  const content = providerMessageContent(message);
  if (message.type === "assistant") {
    const text = content.flatMap((block) => {
      if (!isRecord(block)) return [];
      return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
    }).join("\n");
    if (!text) return [];
    return [{
      type: "assistantMessageCompleted",
      messageId: typeof message.uuid === "string" ? message.uuid : `assistant:${turnId}`,
      turnId,
      content: text,
      contentDigest: digestScenarioValue(text),
    }];
  }
  if (message.type !== "user") return [];
  return content.flatMap((block): ScenarioCommandPayload[] => {
    if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
      return [];
    }
    const output = block.content ?? null;
    return block.is_error === true
      ? [{
          type: "toolFailed",
          toolCallId: block.tool_use_id,
          error: typeof output === "string" ? output : "Tool execution failed",
          output: jsonValue(output),
        }]
      : [{ type: "toolCompleted", toolCallId: block.tool_use_id, output: jsonValue(output) }];
  });
}

export function toolApprovalWaitReason(
  toolName: string,
  options: { title?: string; decisionReason?: string },
): string {
  const reason = typeof options.decisionReason === "string" && options.decisionReason.trim()
    ? options.decisionReason.trim()
    : typeof options.title === "string" && options.title.trim()
      ? options.title.trim()
      : null;
  return reason ?? `Approve ${toolName}`;
}

function providerMessageContent(message: Record<string, unknown>): unknown[] {
  const nested = recordFromUnknown(message.message);
  return Array.isArray(nested.content) ? nested.content : [];
}
