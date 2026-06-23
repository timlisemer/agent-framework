import { AsyncLocalStorage } from "node:async_hooks";

export const MCP_NO_TIMEOUT_MS = 2147483647;
export const DEFAULT_MCP_TIMEOUT_MS = 300_000;

const EXTENDED_MCP_TIMEOUT_MS = 1_500_000;

type TimeoutContext = {
  toolName: string;
  timeoutMs: number;
  controller: AbortController;
  externalSignal: AbortSignal | undefined;
  activeTimer: ReturnType<typeof setTimeout> | undefined;
  remainingMs: number;
  activeSegmentStartedAt: number | undefined;
  pauseDepth: number;
  timedOut: boolean;
  timeoutError: McpToolTimeoutError | undefined;
  rejectAbort: (error: Error) => void;
};

const timeoutStorage = new AsyncLocalStorage<TimeoutContext>();

export class McpToolTimeoutError extends Error {
  readonly toolName: string;
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super(`MCP tool "${toolName}" timed out after ${Math.round(timeoutMs / 1000)} seconds of active work.`);
    this.name = "McpToolTimeoutError";
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

export function mcpTimeoutForTool(toolName: string): number {
  return toolName === "confirm" || toolName === "fullconfirm" || toolName === "commit" || toolName === "implement" || toolName === "validate_implementation"
    ? EXTENDED_MCP_TIMEOUT_MS
    : DEFAULT_MCP_TIMEOUT_MS;
}

export function currentMcpSignal(): AbortSignal | undefined {
  return timeoutStorage.getStore()?.controller.signal;
}

export function pauseMcpTimeout(): void {
  const context = timeoutStorage.getStore();
  if (!context) {
    return;
  }

  context.pauseDepth += 1;
  if (context.pauseDepth === 1) {
    stopActiveTimer(context);
  }
}

export function resumeMcpTimeout(): void {
  const context = timeoutStorage.getStore();
  if (!context || context.pauseDepth === 0) {
    return;
  }

  context.pauseDepth -= 1;
  if (context.pauseDepth === 0) {
    startActiveTimer(context);
  }
}

export async function runMcpToolWithTimeout<T>(
  toolName: string,
  externalSignal: AbortSignal | undefined,
  handler: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const parentContext = timeoutStorage.getStore();
  if (parentContext) {
    return handler(parentContext.controller.signal);
  }

  let rejectAbort!: (error: Error) => void;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const context: TimeoutContext = {
    toolName,
    timeoutMs: mcpTimeoutForTool(toolName),
    controller: new AbortController(),
    externalSignal,
    activeTimer: undefined,
    remainingMs: mcpTimeoutForTool(toolName),
    activeSegmentStartedAt: undefined,
    pauseDepth: 0,
    timedOut: false,
    timeoutError: undefined,
    rejectAbort,
  };

  const abortFromSignal = () => {
    const reason = externalSignal?.reason instanceof Error
      ? externalSignal.reason
      : new Error("MCP tool call cancelled.");
    context.controller.abort(reason);
    rejectAbort(reason);
  };
  const abortFromContext = () => {
    const reason = context.controller.signal.reason instanceof Error
      ? context.controller.signal.reason
      : new Error("MCP tool call cancelled.");
    rejectAbort(reason);
  };

  if (externalSignal?.aborted) {
    abortFromSignal();
  } else {
    externalSignal?.addEventListener("abort", abortFromSignal, { once: true });
  }
  context.controller.signal.addEventListener("abort", abortFromContext, { once: true });

  try {
    return await timeoutStorage.run(context, async () => {
      startActiveTimer(context);
      const handlerPromise = handler(context.controller.signal);
      handlerPromise.catch(() => undefined);
      try {
        return await Promise.race([handlerPromise, abortPromise]);
      } catch (error) {
        if (context.timedOut && context.timeoutError) {
          throw context.timeoutError;
        }
        throw error;
      }
    });
  } finally {
    stopActiveTimer(context);
    externalSignal?.removeEventListener("abort", abortFromSignal);
    context.controller.signal.removeEventListener("abort", abortFromContext);
  }
}

export function formatMcpTimeoutError(error: McpToolTimeoutError): string {
  return `ERROR: MCP tool "${error.toolName}" timed out after ${Math.round(error.timeoutMs / 1000)} seconds of active work. The operation was cancelled.`;
}

function startActiveTimer(context: TimeoutContext): void {
  if (context.timedOut || context.controller.signal.aborted || context.pauseDepth > 0 || context.activeTimer) {
    return;
  }

  if (context.remainingMs <= 0) {
    timeoutContext(context);
    return;
  }

  context.activeSegmentStartedAt = Date.now();
  context.activeTimer = setTimeout(() => timeoutContext(context), context.remainingMs);
}

function stopActiveTimer(context: TimeoutContext): void {
  if (!context.activeTimer) {
    return;
  }

  clearTimeout(context.activeTimer);
  context.activeTimer = undefined;

  if (context.activeSegmentStartedAt !== undefined) {
    const elapsedMs = Math.max(0, Date.now() - context.activeSegmentStartedAt);
    context.remainingMs = Math.max(0, context.remainingMs - elapsedMs);
    context.activeSegmentStartedAt = undefined;
  }
}

function timeoutContext(context: TimeoutContext): void {
  if (context.timedOut) {
    return;
  }

  stopActiveTimer(context);
  context.remainingMs = 0;
  context.timedOut = true;
  context.timeoutError = new McpToolTimeoutError(context.toolName, context.timeoutMs);
  context.controller.abort(context.timeoutError);
  context.rejectAbort(context.timeoutError);
}
