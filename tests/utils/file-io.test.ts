import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { failFileHandleReadAfter } from "../helpers/file-read-failure.js";
import {
  readJsonlTail,
  readJsonlTailWithSequenceIds,
  readValidatedTextFileCancellable,
  scanValidatedFileCancellable,
} from "../../src/utils/file-io.js";

describe("file-io JSONL tail reads", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-file-io-"));
    filePath = path.join(tmpDir, "entries.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps a complete record when the tail window starts exactly on its boundary", () => {
    const first = JSON.stringify({ id: "old" }) + "\n";
    const second = JSON.stringify({ id: "boundary" }) + "\n";
    fs.writeFileSync(filePath, first + second);

    expect(readJsonlTail<{ id: string }>(filePath, Buffer.byteLength(second))).toEqual([
      { id: "boundary" },
    ]);
  });

  it("drops a torn leading record when the tail window starts mid-line", () => {
    const first = JSON.stringify({ id: "old" }) + "\n";
    const second = JSON.stringify({ id: "boundary" }) + "\n";
    fs.writeFileSync(filePath, first + second);

    expect(readJsonlTail<{ id: string }>(filePath, Buffer.byteLength(second) + 2)).toEqual([
      { id: "boundary" },
    ]);
  });

  it("uses bounded offset-based sequence IDs when the tail window skips a large prefix", () => {
    const prefix = Array.from({ length: 10_000 }, (_, index) => JSON.stringify({ id: `old-${index}` })).join("\n") + "\n";
    const finalLine = JSON.stringify({ id: "recent" }) + "\n";
    fs.writeFileSync(filePath, prefix + finalLine);

    const entries = readJsonlTailWithSequenceIds<{ id: string }>(filePath, Buffer.byteLength(finalLine));

    expect(entries).toEqual([
      { sequenceId: Buffer.byteLength(prefix) + 1, entry: { id: "recent" } },
    ]);
  });
});

describe("readValidatedTextFileCancellable", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-safe-file-io-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads bounded regular UTF-8 files", async () => {
    const filePath = path.join(tmpDir, "instructions.md");
    fs.writeFileSync(filePath, "Use double quotes.\n");

    await expect(readValidatedTextFileCancellable(filePath)).resolves.toBe("Use double quotes.\n");
    await expect(readValidatedTextFileCancellable(filePath, { maxBytes: 4 })).resolves.toBeNull();
  });

  it("does not follow symbolic links", async () => {
    const target = path.join(tmpDir, "target.md");
    const link = path.join(tmpDir, "link.md");
    fs.writeFileSync(target, "outside\n");
    fs.symlinkSync(target, link);

    await expect(readValidatedTextFileCancellable(link)).resolves.toBeNull();
  });

  it("honors cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(readValidatedTextFileCancellable("missing", { signal: controller.signal }))
      .rejects.toMatchObject({ name: "OperationCancelledError" });
  });

  it("reports bytes consumed before a later read failure", async () => {
    const target = path.join(tmpDir, "partial-read.txt");
    fs.writeFileSync(target, Buffer.alloc(80 * 1024, 120));
    const originalOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation((async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await originalOpen(...args);
      failFileHandleReadAfter(handle, 1);
      return handle;
    }) as typeof fs.promises.open);
    try {
      await expect(scanValidatedFileCancellable(target, { maxBytes: 128 * 1024 })).resolves.toEqual(
        expect.objectContaining({ kind: "unreadable", scannedBytes: 64 * 1024 }),
      );
    } finally {
      openSpy.mockRestore();
    }
  });
});
