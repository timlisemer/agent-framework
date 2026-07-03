import { AsyncLocalStorage } from "node:async_hooks";

export const MCP_NO_TIMEOUT_MS = 2147483647;
export const DEFAULT_MCP_TIMEOUT_MS = 300_000;
export const CHECK_COMMAND_TIMEOUT_MS = DEFAULT_MCP_TIMEOUT_MS;
export const CHECK_SUMMARY_GRACE_MS = 30_000;
export const CHECK_MCP_TIMEOUT_MS = CHECK_COMMAND_TIMEOUT_MS + CHECK_SUMMARY_GRACE_MS;

const EXTENDED_MCP_TIMEOUT_MS = 1_500_000;

type TimeoutContext = {
  toolName: string;
  timeoutMs: number;
  phase: string | undefined;
  controller: AbortController;
  externalSignal: AbortSignal | undefined;
  activeTimer: ReturnType<typeof setTimeout> | undefined;
  remainingMs: number;
  activeSegmentStartedAt: number | undefined;
  pauseDepth: number;
  timedOut: boolean;
  timeoutError: McpToolTimeoutError | undefined;
};

type AbortableRaceTimeout = {
  timeoutMs: number;
  createError: () => Error;
};

type AbortableRaceOptions = {
  controller: AbortController;
  externalSignal?: AbortSignal;
  timeout?: AbortableRaceTimeout;
};

const timeoutStorage = new AsyncLocalStorage<TimeoutContext>();

export class McpToolTimeoutError extends Error {
  readonly toolName: string;
  readonly timeoutMs: number;
  readonly phase: string | undefined;

  constructor(toolName: string, timeoutMs: number, phase?: string) {
    super(formatMcpTimeoutCore(toolName, timeoutMs, phase));
    this.name = "McpToolTimeoutError";
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
    this.phase = phase;
  }
}

export function mcpTimeoutForTool(toolName: string): number {
  if (toolName === "check") return CHECK_MCP_TIMEOUT_MS;
  return toolName === "confirm" || toolName === "fullconfirm" || toolName === "commit" || toolName === "implement" || toolName === "validate_implementation"
    ? EXTENDED_MCP_TIMEOUT_MS
    : DEFAULT_MCP_TIMEOUT_MS;
}

export function currentMcpSignal(): AbortSignal | undefined {
  return timeoutStorage.getStore()?.controller.signal;
}

export function setMcpTimeoutPhase(phase: string | undefined): void {
  const context = timeoutStorage.getStore();
  if (!context) {
    return;
  }

  context.phase = phase;
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

export async function runWithPausedMcpTimeout<T>(fn: () => Promise<T>): Promise<T> {
  pauseMcpTimeout();
  try {
    return await fn();
  } finally {
    resumeMcpTimeout();
  }
}

export async function runWithMcpChildTimeout<T>(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  createTimeoutError: () => Error,
  handler: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return runAbortableRace(
    {
      controller: new AbortController(),
      externalSignal,
      timeout: { timeoutMs, createError: createTimeoutError },
    },
    handler,
  );
}

async function runAbortableRace<T>(
  options: AbortableRaceOptions,
  handler: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let rejectAbort!: (error: Error) => void;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });

  const abortFromSignal = () => {
    const reason = options.externalSignal?.reason instanceof Error
      ? options.externalSignal.reason
      : new Error("MCP tool call cancelled.");
    options.controller.abort(reason);
    rejectAbort(reason);
  };
  const abortFromController = () => {
    const reason = options.controller.signal.reason instanceof Error
      ? options.controller.signal.reason
      : new Error("MCP tool call cancelled.");
    rejectAbort(reason);
  };

  if (options.externalSignal?.aborted) {
    abortFromSignal();
  } else {
    options.externalSignal?.addEventListener("abort", abortFromSignal, { once: true });
  }
  options.controller.signal.addEventListener("abort", abortFromController, { once: true });

  const timeout = options.timeout
    ? setTimeout(() => {
        const error = options.timeout!.createError();
        options.controller.abort(error);
        rejectAbort(error);
      }, options.timeout.timeoutMs)
    : undefined;
  timeout?.unref?.();

  try {
    const handlerPromise = handler(options.controller.signal);
    handlerPromise.catch(() => undefined);
    return await Promise.race([handlerPromise, abortPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    options.externalSignal?.removeEventListener("abort", abortFromSignal);
    options.controller.signal.removeEventListener("abort", abortFromController);
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

  const context: TimeoutContext = {
    toolName,
    timeoutMs: mcpTimeoutForTool(toolName),
    phase: undefined,
    controller: new AbortController(),
    externalSignal,
    activeTimer: undefined,
    remainingMs: mcpTimeoutForTool(toolName),
    activeSegmentStartedAt: undefined,
    pauseDepth: 0,
    timedOut: false,
    timeoutError: undefined,
  };

  try {
    return await timeoutStorage.run(context, async () => {
      startActiveTimer(context);
      try {
        return await runAbortableRace(
          { controller: context.controller, externalSignal },
          handler,
        );
      } catch (error) {
        if (context.timedOut && context.timeoutError) {
          throw context.timeoutError;
        }
        throw error;
      }
    });
  } finally {
    stopActiveTimer(context);
  }
}

export function formatMcpTimeoutError(error: McpToolTimeoutError): string {
  return `ERROR: ${formatMcpTimeoutCore(error.toolName, error.timeoutMs, error.phase)} The operation was cancelled.`;
}

function formatMcpTimeoutCore(
  toolName: string,
  timeoutMs: number,
  phase?: string,
): string {
  const phaseText = phase ? ` during ${phase}` : "";
  return `MCP tool "${toolName}" timed out after ${Math.round(timeoutMs / 1000)} seconds of active work${phaseText}.`;
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
  context.timeoutError = new McpToolTimeoutError(context.toolName, context.timeoutMs, context.phase);
  context.controller.abort(context.timeoutError);
}
