import { describe, it, expect, vi, afterEach } from "vitest";
import {
  CHECK_COMMAND_TIMEOUT_MS,
  CHECK_MCP_TIMEOUT_MS,
  CHECK_SUMMARY_GRACE_MS,
  DEFAULT_MCP_TIMEOUT_MS,
  McpToolTimeoutError,
  currentMcpSignal,
  formatMcpTimeoutError,
  mcpTimeoutForTool,
  pauseMcpTimeout,
  resumeMcpTimeout,
  runWithMcpChildTimeout,
  runMcpToolWithTimeout,
  setMcpTimeoutPhase,
} from "../../src/mcp/timeout.js";

describe("mcp timeout policy", () => {
  it("uses the default timeout for ordinary tools", () => {
    expect(mcpTimeoutForTool("push")).toBe(DEFAULT_MCP_TIMEOUT_MS);
  });

  it("uses the check command timeout plus summary grace for check", () => {
    expect(CHECK_COMMAND_TIMEOUT_MS).toBe(DEFAULT_MCP_TIMEOUT_MS);
    expect(CHECK_MCP_TIMEOUT_MS).toBe(330_000);
    expect(mcpTimeoutForTool("check")).toBe(CHECK_MCP_TIMEOUT_MS);
  });

  it("uses 1500 seconds for confirm, fullconfirm, commit, implement, and implementation validation", () => {
    expect(mcpTimeoutForTool("confirm")).toBe(1_500_000);
    expect(mcpTimeoutForTool("fullconfirm")).toBe(1_500_000);
    expect(mcpTimeoutForTool("commit")).toBe(1_500_000);
    expect(mcpTimeoutForTool("implement")).toBe(1_500_000);
    expect(mcpTimeoutForTool("validate_implementation")).toBe(1_500_000);
  });
});

describe("runMcpToolWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out after the check active-work timeout", async () => {
    vi.useFakeTimers();

    const result = runMcpToolWithTimeout("check", undefined, () => new Promise(() => undefined));
    const assertion = expect(result).rejects.toMatchObject({
      name: "McpToolTimeoutError",
      toolName: "check",
      timeoutMs: CHECK_MCP_TIMEOUT_MS,
    });
    await vi.advanceTimersByTimeAsync(CHECK_MCP_TIMEOUT_MS);

    await assertion;
  });

  it("includes the active phase in timeout errors", async () => {
    vi.useFakeTimers();

    const result = runMcpToolWithTimeout("check", undefined, () => {
      setMcpTimeoutPhase("run just check");
      return new Promise(() => undefined);
    });
    const assertion = expect(result).rejects.toMatchObject({
      name: "McpToolTimeoutError",
      toolName: "check",
      timeoutMs: CHECK_MCP_TIMEOUT_MS,
      phase: "run just check",
    });
    await vi.advanceTimersByTimeAsync(CHECK_MCP_TIMEOUT_MS);

    await assertion;
  });

  it("excludes paused elapsed time from the active-work timeout", async () => {
    vi.useFakeTimers();
    let resolveHandler!: () => void;

    const result = runMcpToolWithTimeout("check", undefined, async () => {
      pauseMcpTimeout();
      await vi.advanceTimersByTimeAsync(CHECK_MCP_TIMEOUT_MS * 2);
      resumeMcpTimeout();
      await vi.advanceTimersByTimeAsync(CHECK_MCP_TIMEOUT_MS - 1);
      await Promise.resolve();
      resolveHandler();
      return "done";
    });
    const handlerGate = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });

    await handlerGate;

    await expect(result).resolves.toBe("done");
  });

  it("lets a later check subprocess timeout after prior check work consumed summary grace", async () => {
    vi.useFakeTimers();
    let resolveHandler!: () => void;

    const result = runMcpToolWithTimeout("check", undefined, async () => {
      await vi.advanceTimersByTimeAsync(CHECK_SUMMARY_GRACE_MS + 1_000);
      pauseMcpTimeout();
      await vi.advanceTimersByTimeAsync(CHECK_COMMAND_TIMEOUT_MS);
      resumeMcpTimeout();
      await Promise.resolve();
      resolveHandler();
      return "summary after command timeout";
    });
    const handlerGate = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });

    await handlerGate;

    await expect(result).resolves.toBe("summary after command timeout");
  });

  it("uses the outer signal and ignores the nested tool timeout", async () => {
    vi.useFakeTimers();
    let outerSignal: AbortSignal | undefined;
    let innerSignal: AbortSignal | undefined;

    const result = runMcpToolWithTimeout("commit", undefined, async (signal) => {
      outerSignal = signal;
      await vi.advanceTimersByTimeAsync(400_000);
      return runMcpToolWithTimeout("check", undefined, async (nestedSignal) => {
        innerSignal = nestedSignal;
        return "nested done";
      });
    });

    await expect(result).resolves.toBe("nested done");
    expect(innerSignal).toBe(outerSignal);
  });

  it("propagates external aborts to the MCP context signal", async () => {
    const controller = new AbortController();
    let contextSignal: AbortSignal | undefined;
    let rejectHandler!: (error: Error) => void;
    const handlerError = new Error("aborted by signal");

    const result = runMcpToolWithTimeout("check", controller.signal, async (signal) => {
      contextSignal = signal;
      return new Promise<never>((_, reject) => {
        rejectHandler = reject;
        signal.addEventListener("abort", () => reject(handlerError), { once: true });
      });
    });

    controller.abort(new Error("external abort"));

    await expect(result).rejects.toThrow("external abort");
    expect(contextSignal?.aborted).toBe(true);
    rejectHandler(handlerError);
  });
});

describe("formatMcpTimeoutError", () => {
  it("formats a clear timeout message", () => {
    expect(formatMcpTimeoutError(new McpToolTimeoutError("confirm", 1_500_000))).toBe(
      'ERROR: MCP tool "confirm" timed out after 1500 seconds of active work. The operation was cancelled.',
    );
  });

  it("formats timeout phase details when present", () => {
    expect(formatMcpTimeoutError(new McpToolTimeoutError("check", CHECK_MCP_TIMEOUT_MS, "run just check"))).toBe(
      'ERROR: MCP tool "check" timed out after 330 seconds of active work during run just check. The operation was cancelled.',
    );
  });
});

describe("currentMcpSignal", () => {
  it("returns the active context signal", async () => {
    let signal: AbortSignal | undefined;

    await runMcpToolWithTimeout("check", undefined, async () => {
      signal = currentMcpSignal();
      return undefined;
    });

    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("runWithMcpChildTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cleans up timeout state when handler throws synchronously", async () => {
    vi.useFakeTimers();
    let timeoutErrorCreated = 0;

    await expect(
      runWithMcpChildTimeout(
        undefined,
        100,
        () => {
          timeoutErrorCreated++;
          return new Error("child timeout");
        },
        () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    await vi.advanceTimersByTimeAsync(100);
    expect(timeoutErrorCreated).toBe(0);
  });
});
