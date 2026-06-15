import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readJsonlTail } from "../../src/utils/file-io.js";

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
});
