import { describe, expect, it, vi } from "vitest";
import { RuntimeAuthorizationWaiter } from "../../src/scenario/runtime/authorization-waiter.js";

describe("RuntimeAuthorizationWaiter", () => {
  it.each([false, true])(
    "preserves cancellation settlement when its observer throws (already aborted: %s)",
    async (alreadyAborted) => {
      const waiter = new RuntimeAuthorizationWaiter();
      const controller = new AbortController();
      if (alreadyAborted) controller.abort();
      const observeCancellation = vi.fn(() => {
        throw new Error("observer failed");
      });

      const pending = waiter.wait(
        "run-1",
        null,
        `tool-${alreadyAborted}`,
        controller.signal,
        observeCancellation,
      );
      if (!alreadyAborted) controller.abort();

      await expect(pending).rejects.toMatchObject({
        name: "OperationCancelledError",
        message: "Tool authorization cancelled",
      });
      expect(observeCancellation).toHaveBeenCalledOnce();
    },
  );
});
