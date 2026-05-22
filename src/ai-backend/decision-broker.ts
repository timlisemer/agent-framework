import type { AiToolDecision, ToolCallId } from "../ai-protocol/index.js";
import { OperationCancelledError } from "../utils/cancellation.js";

type PendingDecision = {
  resolve(decision: AiToolDecision): void;
  reject(error: Error): void;
};

export class DecisionBroker {
  readonly #pending = new Map<ToolCallId, PendingDecision>();

  waitForDecision(toolCallId: ToolCallId, signal?: AbortSignal): Promise<AiToolDecision> {
    if (this.#pending.has(toolCallId)) {
      return Promise.reject(new Error(`Tool decision already pending: ${toolCallId}`));
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(toolCallId);
        reject(new OperationCancelledError("Tool decision cancelled"));
      };
      if (signal?.aborted) {
        reject(new OperationCancelledError("Tool decision cancelled"));
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(toolCallId, {
        resolve: (decision) => {
          signal?.removeEventListener("abort", abort);
          resolve(decision);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
    });
  }

  submit(decision: AiToolDecision): boolean {
    const pending = this.#pending.get(decision.toolCallId);
    if (!pending) return false;
    this.#pending.delete(decision.toolCallId);
    pending.resolve(decision);
    return true;
  }

  reject(toolCallId: ToolCallId, error: Error): boolean {
    const pending = this.#pending.get(toolCallId);
    if (!pending) return false;
    this.#pending.delete(toolCallId);
    pending.reject(error);
    return true;
  }
}
