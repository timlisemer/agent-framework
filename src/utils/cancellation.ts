export class OperationCancelledError extends Error {
  constructor(message = "Operation cancelled") {
    super(message);
    this.name = "OperationCancelledError";
  }
}

export type CancellationOptions = {
  signal?: AbortSignal;
};

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OperationCancelledError();
  }
}

export function isCancellationError(error: unknown): boolean {
  if (error instanceof OperationCancelledError) {
    return true;
  }

  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "OperationCancelledError";
  }

  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name?: unknown }).name;
    return name === "AbortError" || name === "OperationCancelledError";
  }

  return false;
}

export function linkAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController
): () => void {
  if (!signal) {
    return () => undefined;
  }

  if (signal.aborted) {
    controller.abort();
    return () => undefined;
  }

  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new OperationCancelledError());
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
    };

    signal?.addEventListener("abort", abort, { once: true });
  });
}
