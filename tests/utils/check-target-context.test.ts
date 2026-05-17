import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  extractCheckBody,
  getCheckTargetContext,
  resolveCheckMessage,
  clearCheckTargetCache,
} from "../../src/utils/check-target-context.js";
import { activeSpec } from "../../src/adapter/spec.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "check-ctx-test-"));
}

describe("extractCheckBody", () => {
  describe("justfile format", () => {
    it("extracts indented body after check recipe", () => {
      const content = `build:\n  cargo build\n\ncheck:\n  cargo clippy\n  cargo test\n\nrun:\n  cargo run`;
      const body = extractCheckBody(content, "just");
      expect(body).toContain("cargo clippy");
      expect(body).toContain("cargo test");
      expect(body).not.toContain("cargo build");
      expect(body).not.toContain("cargo run");
    });

    it("handles @check (silent) prefix", () => {
      const content = `@check:\n  tsc --noEmit\n  eslint .`;
      const body = extractCheckBody(content, "just");
      expect(body).toContain("tsc --noEmit");
      expect(body).toContain("eslint");
    });

    it("returns null when no check recipe", () => {
      const content = `build:\n  cargo build\n\ntest:\n  cargo test`;
      expect(extractCheckBody(content, "just")).toBeNull();
    });

    it("handles check at end of file", () => {
      const content = `build:\n  cargo build\n\ncheck:\n  tsc`;
      const body = extractCheckBody(content, "just");
      expect(body).toContain("tsc");
    });
  });

  describe("makefile format", () => {
    it("extracts tab-indented body after check target", () => {
      const content = `build:\n\tcargo build\n\ncheck:\n\tcargo clippy\n\tcargo test\n\nrun:\n\tcargo run`;
      const body = extractCheckBody(content, "make");
      expect(body).toContain("cargo clippy");
      expect(body).toContain("cargo test");
      expect(body).not.toContain("cargo build");
      expect(body).not.toContain("cargo run");
    });

    it("handles check with prerequisites", () => {
      const content = `check: build lint\n\tcargo test`;
      const body = extractCheckBody(content, "make");
      expect(body).toContain("cargo test");
    });

    it("returns null when no check target", () => {
      const content = `build:\n\tcargo build`;
      expect(extractCheckBody(content, "make")).toBeNull();
    });
  });
});

describe("getCheckTargetContext", () => {
  beforeEach(() => {
    clearCheckTargetCache();
  });

  it("returns null runner when no build file exists", () => {
    const dir = createTempDir();
    const ctx = getCheckTargetContext(dir);
    expect(ctx.runner).toBeNull();
    expect(ctx.hasCheckTarget).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  it("detects Justfile with check recipe", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Justfile"), "check:\n  cargo clippy\n  cargo test\n");
    const ctx = getCheckTargetContext(dir);
    expect(ctx.runner).toBe("just");
    expect(ctx.hasCheckTarget).toBe(true);
    expect(ctx.checkBody).toContain("cargo clippy");
    fs.rmSync(dir, { recursive: true });
  });

  it("detects Makefile with check target", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Makefile"), "check:\n\tmake lint\n\tmake test\n");
    const ctx = getCheckTargetContext(dir);
    expect(ctx.runner).toBe("make");
    expect(ctx.hasCheckTarget).toBe(true);
    expect(ctx.checkBody).toContain("make lint");
    fs.rmSync(dir, { recursive: true });
  });

  it("detects Justfile without check recipe", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Justfile"), "build:\n  cargo build\n");
    const ctx = getCheckTargetContext(dir);
    expect(ctx.runner).toBe("just");
    expect(ctx.hasCheckTarget).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  it("prefers Justfile over Makefile", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Justfile"), "check:\n  just-cmd\n");
    fs.writeFileSync(path.join(dir, "Makefile"), "check:\n\tmake-cmd\n");
    const ctx = getCheckTargetContext(dir);
    expect(ctx.runner).toBe("just");
    expect(ctx.checkBody).toContain("just-cmd");
    fs.rmSync(dir, { recursive: true });
  });

  it("caches results per directory", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Justfile"), "check:\n  cargo test\n");
    const ctx1 = getCheckTargetContext(dir);
    const ctx2 = getCheckTargetContext(dir);
    expect(ctx1).toBe(ctx2);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("resolveCheckMessage", () => {
  const prevAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;

  beforeEach(() => {
    process.env.AGENT_FRAMEWORK_ADAPTER = "claude";
    clearCheckTargetCache();
  });

  afterEach(() => {
    if (prevAdapter === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
    else process.env.AGENT_FRAMEWORK_ADAPTER = prevAdapter;
  });

  function expectedCheckWireName(): string {
    return activeSpec().mcpWireName("check");
  }

  it("tier 1: no build file", () => {
    const dir = createTempDir();
    const msg = resolveCheckMessage("cargo build", ["cargo check", "cargo clippy"], dir);
    expect(msg).toContain("No Justfile/Makefile found");
    expect(msg).toContain(expectedCheckWireName());
    fs.rmSync(dir, { recursive: true });
  });

  it("tier 2: file exists but no check target", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Justfile"), "build:\n  cargo build\n");
    const msg = resolveCheckMessage("cargo build", ["cargo check", "cargo clippy"], dir);
    expect(msg).toContain("Justfile found but no check target");
    expect(msg).toContain(expectedCheckWireName());
    fs.rmSync(dir, { recursive: true });
  });

  it("tier 3: check target exists but command not covered", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Justfile"), "check:\n  tsc --noEmit\n");
    const msg = resolveCheckMessage("cargo build", ["cargo check", "cargo clippy"], dir);
    expect(msg).toContain("cargo build is not covered by the detected check target");
    expect(msg).toContain(expectedCheckWireName());
    expect(msg).not.toContain("run just check");
    fs.rmSync(dir, { recursive: true });
  });

  it("tier 4: command covered via equivalent", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Justfile"), "check:\n  cargo clippy\n  cargo test\n");
    const msg = resolveCheckMessage("cargo build", ["cargo check", "cargo clippy"], dir);
    expect(msg).toContain("cargo build is covered by the agent-framework check MCP");
    expect(msg).toContain("matched check target entry: cargo clippy");
    expect(msg).toContain(expectedCheckWireName());
    expect(msg).not.toContain("run just check");
    fs.rmSync(dir, { recursive: true });
  });

  it("uses Makefile context without recommending make check", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Makefile"), "check:\n\tcargo clippy\n");
    const msg = resolveCheckMessage("cargo build", ["cargo check", "cargo clippy"], dir);
    expect(msg).toContain("agent-framework check MCP");
    expect(msg).not.toContain("run make check");
    fs.rmSync(dir, { recursive: true });
  });

  it("blocks direct check runner shell commands in favor of the check MCP", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "Justfile"), "check:\n  tsc --noEmit\n");
    const msg = resolveCheckMessage("just check", ["check"], dir);
    expect(msg).toContain("just check shell command is blocked");
    expect(msg).toContain(expectedCheckWireName());
    expect(msg).not.toContain("covered by");
    fs.rmSync(dir, { recursive: true });
  });

  it("all messages contain forceful wording", () => {
    const dir = createTempDir();
    const msg = resolveCheckMessage("tsc", ["tsc"], dir);
    expect(msg).toContain("You must run");
    fs.rmSync(dir, { recursive: true });
  });
});
