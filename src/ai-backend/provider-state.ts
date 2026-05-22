import type { AiBackendProcessId, AiMessageId, ToolCallId } from "../ai-protocol/index.js";
import type { RuntimeRef } from "./runtime-events.js";

export class ProviderState {
  #messageCounter = 0;
  #toolCounter = 0;
  #processCounter = 0;
  readonly #messages = new Map<RuntimeRef, AiMessageId>();
  readonly #tools = new Map<RuntimeRef, ToolCallId>();
  readonly #toolRefs = new Map<ToolCallId, RuntimeRef>();
  readonly #processes = new Map<RuntimeRef, AiBackendProcessId>();

  messageId(ref: RuntimeRef = "assistant"): AiMessageId {
    const existing = this.#messages.get(ref);
    if (existing) return existing;
    const id = `message-${++this.#messageCounter}`;
    this.#messages.set(ref, id);
    return id;
  }

  nextMessageId(): AiMessageId {
    return `message-${++this.#messageCounter}`;
  }

  resetRuntimeRefs(): void {
    this.#messages.clear();
    this.#tools.clear();
    this.#toolRefs.clear();
    this.#processes.clear();
  }

  toolId(ref: RuntimeRef): ToolCallId {
    const existing = this.#tools.get(ref);
    if (existing) return existing;
    const id = `tool-${++this.#toolCounter}`;
    this.#tools.set(ref, id);
    this.#toolRefs.set(id, ref);
    return id;
  }

  toolRef(id: ToolCallId): RuntimeRef | null {
    return this.#toolRefs.get(id) ?? null;
  }

  processId(ref: RuntimeRef): AiBackendProcessId {
    const existing = this.#processes.get(ref);
    if (existing) return existing;
    const id = `process-${++this.#processCounter}`;
    this.#processes.set(ref, id);
    return id;
  }
}
