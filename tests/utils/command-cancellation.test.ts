import { describe, expect, it } from "vitest";
import { runProcessCancellable } from "../../src/utils/command.js";

describe("runProcessCancellable", () => {
  it("rejects with OperationCancelledError when aborted", async () => {
    const controller = new AbortController();
    const running = runProcessCancellable(
      { shell: true, command: "node -e \"setTimeout(() => {}, 10000)\"" },
      process.cwd(),
      { signal: controller.signal },
    );

    controller.abort();

    await expect(running).rejects.toMatchObject({ name: "OperationCancelledError" });
  });
});
