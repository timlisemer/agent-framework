import { OperationCancelledError } from "../../utils/cancellation.js";
import type { ToolDecision } from "../protocol/commands.js";

export type PendingAuthorizationDecision = {
  decision: ToolDecision;
  reason: string | null;
};

type PendingAuthorization = {
  runId: string;
  turnId: string | null;
  resolve(decision: PendingAuthorizationDecision): void;
  reject(error: Error): void;
  cancel(error: OperationCancelledError): void;
};

/** Coordination only; policy and pending state remain canonical runtime state. */
export class RuntimeAuthorizationWaiter {
  private readonly pending = new Map<string, PendingAuthorization>();

  public wait(
    runId: string,
    turnId: string | null,
    toolCallId: string,
    signal?: AbortSignal,
    onCancelled?: (error: OperationCancelledError) => void,
  ): Promise<PendingAuthorizationDecision> {
    const key = authorizationKey(runId, toolCallId);
    if (this.pending.has(key)) throw new Error(`Authorization waiter already exists: ${toolCallId}`);
    const decision = new Promise<PendingAuthorizationDecision>((resolve, reject) => {
      const rejectCancellation = (error: OperationCancelledError) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
        try {
          onCancelled?.(error);
        } catch {
          // Cancellation settlement is authoritative even if optional observation fails.
        }
      };
      const abort = () => {
        this.pending.delete(key);
        rejectCancellation(new OperationCancelledError("Tool authorization cancelled"));
      };
      if (signal?.aborted) {
        rejectCancellation(new OperationCancelledError("Tool authorization cancelled"));
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(key, {
        runId,
        turnId,
        resolve: (decision) => {
          signal?.removeEventListener("abort", abort);
          resolve(decision);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
        cancel: rejectCancellation,
      });
    });
    // The provider may still be persisting its canonical request when the
    // signal aborts. Observe the deferred immediately while returning the
    // original rejected promise to the provider caller.
    void decision.catch(() => undefined);
    return decision;
  }

  public settle(runId: string, toolCallId: string, decision: PendingAuthorizationDecision): boolean {
    const key = authorizationKey(runId, toolCallId);
    const pending = this.pending.get(key);
    if (!pending) return false;
    this.pending.delete(key);
    pending.resolve(decision);
    return true;
  }

  public fail(runId: string, toolCallId: string, error: Error): boolean {
    const key = authorizationKey(runId, toolCallId);
    const pending = this.pending.get(key);
    if (!pending) return false;
    this.pending.delete(key);
    pending.reject(error);
    return true;
  }

  public cancelRun(runId: string, reason: string): number {
    return this.cancelMatching(
      (pending) => pending.runId === runId,
      new OperationCancelledError(reason),
    );
  }

  public cancelTurn(runId: string, turnId: string, reason: string): number {
    return this.cancelMatching(
      (pending) => pending.runId === runId && pending.turnId === turnId,
      new OperationCancelledError(reason),
    );
  }

  private cancelMatching(
    matches: (pending: PendingAuthorization) => boolean,
    error: OperationCancelledError,
  ): number {
    let cancelled = 0;
    for (const [key, pending] of this.pending) {
      if (!matches(pending)) continue;
      this.pending.delete(key);
      pending.cancel(error);
      cancelled += 1;
    }
    return cancelled;
  }

}

function authorizationKey(runId: string, toolCallId: string): string {
  return JSON.stringify([runId, toolCallId]);
}
