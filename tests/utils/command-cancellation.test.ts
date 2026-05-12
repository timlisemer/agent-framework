import { describe, expect, it } from "vitest";
import { runProcessCancellable } from "../../src/utils/command.js";

describe("runProcessCancellable", () => {
  it("caps stdout and emits a truncation marker", async () => {
    const result = await runProcessCancellable(
      { shell: true, command: "node -e \"process.stdout.write('x'.repeat(1000))\"" },
      process.cwd(),
      { maxStdoutBytes: 32 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("[agent-framework: stdout truncated after 32 bytes]");
    expect(result.output.length).toBeLessThan(140);
  });

  it("caps stderr and emits a truncation marker", async () => {
    const result = await runProcessCancellable(
      { shell: true, command: "node -e \"process.stderr.write('x'.repeat(1000))\"" },
      process.cwd(),
      { maxStderrBytes: 32 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("[agent-framework: stderr truncated after 32 bytes]");
    expect(result.output.length).toBeLessThan(140);
  });

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
