import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readJsonlTail, readJsonlTailWithSequenceIds } from "../../src/utils/file-io.js";

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
