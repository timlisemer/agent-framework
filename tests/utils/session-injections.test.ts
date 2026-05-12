import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendSessionInjections,
  combineInjectionMessages,
  loadSessionInjectionsBySeq,
  readSessionInjectionsAfterOffset,
  readSessionInjectionsThroughOffset,
  shortContentHash,
} from "../../src/utils/session-injections.js";
import { sessionInjectionsFile } from "../../src/utils/paths.js";

describe("session-injections", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-injections-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends records with seqs and short hashes", () => {
    const records = appendSessionInjections(tmpDir, "UserPromptSubmit", [
      { id: "a", trigger: "t", channel: "context", message: "one" },
      { id: "b", trigger: "t", channel: "context", message: "two" },
    ]);

    expect(records.map((record) => record.seq)).toEqual([1, 2]);
    expect(records[0].message_hash).toBe(shortContentHash("one"));
    expect(loadSessionInjectionsBySeq(tmpDir, [2]).map((record) => record.id)).toEqual(["b"]);
    expect(combineInjectionMessages(records)).toBe("one\n\ntwo");
  });

  it("reads complete records around byte offsets and ignores a torn trailing line", () => {
    appendSessionInjections(tmpDir, "SessionStart", [
      { id: "a", trigger: "t", channel: "context", message: "one" },
    ]);
    const offset = fs.statSync(sessionInjectionsFile(tmpDir)).size;
    appendSessionInjections(tmpDir, "UserPromptSubmit", [
      { id: "b", trigger: "t", channel: "context", message: "two" },
    ]);
    fs.appendFileSync(sessionInjectionsFile(tmpDir), "{\"seq\":");

    expect(readSessionInjectionsThroughOffset(tmpDir, offset).map((record) => record.id)).toEqual(["a"]);
    expect(readSessionInjectionsAfterOffset(tmpDir, offset).map((record) => record.id)).toEqual(["b"]);
  });
});
