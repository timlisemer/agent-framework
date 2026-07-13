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
    expect(result.stdoutTruncated).toBe(true);
  });

  it("reports truncation when the retained prefix ends at an exact NUL boundary", async () => {
    const result = await runProcessCancellable(
      {
        shell: false,
        file: process.execPath,
        args: ["-e", "process.stdout.write('?? a\\0'); setTimeout(() => process.stdout.write('?? b\\0'), 50)"],
      },
      process.cwd(),
      { maxStdoutBytes: 5 },
    );

    expect(result.output).toBe("?? a\0");
    expect(result.stdoutTruncated).toBe(true);
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

  it("does not corrupt multibyte characters at a bounded prefix", async () => {
    const result = await runProcessCancellable(
      { shell: false, file: process.execPath, args: ["-e", "process.stdout.write('😀'.repeat(20))"] },
      process.cwd(),
      { maxStdoutBytes: 7 },
    );

    expect(result.output).not.toContain("�");
    expect(result.stdoutTruncated).toBe(true);
  });

  it("does not corrupt multibyte characters at preserved head or tail boundaries", async () => {
    const result = await runProcessCancellable(
      { shell: false, file: process.execPath, args: ["-e", "process.stdout.write('😀'.repeat(20))"] },
      process.cwd(),
      { maxStdoutBytes: 11, preserveTailOnTruncate: true },
    );

    expect(result.output).not.toContain("�");
    expect(result.stdoutTruncated).toBe(true);
  });

  it("decodes a multibyte character split across stream events", async () => {
    const script = [
      "const value = Buffer.from('😀');",
      "process.stdout.write(value.subarray(0, 2));",
      "setTimeout(() => process.stdout.write(value.subarray(2)), 50);",
    ].join("");
    const result = await runProcessCancellable(
      { shell: false, file: process.execPath, args: ["-e", script] },
      process.cwd(),
    );

    expect(result.output).toBe("😀");
    expect(result.stdoutTruncated).toBe(false);
  });

  it("clips valid UTF-8 split across events without manufacturing invalid output", async () => {
    const script = [
      "const value = Buffer.from('😀');",
      "process.stdout.write(value.subarray(0, 2));",
      "setTimeout(() => process.stdout.write(value.subarray(2)), 50);",
    ].join("");
    const result = await runProcessCancellable(
      { shell: false, file: process.execPath, args: ["-e", script] },
      process.cwd(),
      { maxStdoutBytes: 3 },
    );

    expect(result.output).not.toContain("�");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutInvalidUtf8).toBe(false);
  });

  it("flags malformed UTF-8 without silently deleting following output", async () => {
    const script = "process.stdout.write(Buffer.from([0xff, 0x61]))";
    const result = await runProcessCancellable(
      { shell: false, file: process.execPath, args: ["-e", script] },
      process.cwd(),
    );

    expect(result.output).toContain("a");
    expect(result.stdoutInvalidUtf8).toBe(true);
  });

  it("flags an incomplete terminal UTF-8 sequence", async () => {
    const script = "process.stdout.write(Buffer.from([0xe2, 0x82]))";
    const result = await runProcessCancellable(
      { shell: false, file: process.execPath, args: ["-e", script] },
      process.cwd(),
    );

    expect(result.output).toContain("�");
    expect(result.stdoutInvalidUtf8).toBe(true);
  });

  it("preserves head and tail output when requested", async () => {
    const result = await runProcessCancellable(
      {
        shell: false,
        file: process.execPath,
        args: ["-e", "process.stdout.write('HEAD-' + 'x'.repeat(1000) + '-TAIL')"],
      },
      process.cwd(),
      { maxStdoutBytes: 20, preserveTailOnTruncate: true },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("HEAD-");
    expect(result.output).toContain("-TAIL");
    expect(result.output).toContain("[agent-framework: stdout truncated after 20 bytes]");
  });

  it("passes env overrides to child processes", async () => {
    const result = await runProcessCancellable(
      { shell: true, command: "node -e \"process.stdout.write(process.env.AGENT_FRAMEWORK_ADAPTER || '')\"" },
      process.cwd(),
      { env: { AGENT_FRAMEWORK_ADAPTER: "claude" } },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("claude");
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

  it("resolves with captured output when command timeout elapses", async () => {
    const result = await runProcessCancellable(
      {
        shell: false,
        file: process.execPath,
        args: ["-e", "process.stdout.write('before-timeout'); setTimeout(() => {}, 10000);"],
      },
      process.cwd(),
      { commandTimeoutMs: 1_000 },
    );

    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.timeoutMs).toBe(1_000);
    expect(result.output).toContain("before-timeout");
    expect(result.output).toContain("[agent-framework: command timed out after 1 second; process terminated]");
  });
});
