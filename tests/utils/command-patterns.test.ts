import { describe, it, expect } from "vitest";
import {
  BLACKLIST_PATTERNS,
  getBlacklistDescription,
  getContentBlacklistHighlights,
  getBlacklistHighlights,
  detectWorkaroundPattern,
} from "../../src/utils/command-patterns.js";

describe("getBlacklistDescription", () => {
  it("returns a non-empty string", () => {
    expect(getBlacklistDescription().length).toBeGreaterThan(0);
  });

  it("includes all blacklist pattern names", () => {
    const description = getBlacklistDescription();
    for (const { name } of BLACKLIST_PATTERNS) {
      expect(description).toContain(name);
    }
  });
});

describe("getContentBlacklistHighlights", () => {
  it("returns empty array for clean content", () => {
    expect(getContentBlacklistHighlights("const x = 1;\nreturn x;")).toEqual([]);
  });

  it("detects 'cat somefile' in content", () => {
    const highlights = getContentBlacklistHighlights("cat /etc/passwd");
    expect(highlights.length).toBe(1);
    expect(highlights[0]).toContain("cat");
    expect(highlights[0]).toContain("VIOLATION");
  });

  it("detects 'grep pattern' in content", () => {
    const highlights = getContentBlacklistHighlights("grep -r 'foo' .");
    expect(highlights.length).toBe(1);
    expect(highlights[0]).toContain("grep");
  });

  it("detects 'git commit' in content", () => {
    const highlights = getContentBlacklistHighlights("git commit -m 'fix'");
    expect(highlights.length).toBe(1);
    expect(highlights[0]).toContain("git write op");
  });

  it("detects 'npm install' in content", () => {
    const highlights = getContentBlacklistHighlights("npm install express");
    expect(highlights.length).toBe(1);
    expect(highlights[0]).toContain("npm install");
  });

  it("returns one highlight per line (not per pattern)", () => {
    // "cat somefile" matches both 'cat' pattern; one highlight per line
    const highlights = getContentBlacklistHighlights("cat somefile\ngrep pattern");
    expect(highlights).toHaveLength(2);
  });

  it("detects 'tsc' in content", () => {
    const highlights = getContentBlacklistHighlights("npx tsc --noEmit");
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0]).toContain("tsc");
  });

  it("ignores commands inside function call expressions", () => {
    expect(getContentBlacklistHighlights("replay.ts uses execSync('just build')")).toEqual([]);
  });

  it("ignores commands inside double-quoted strings", () => {
    expect(getContentBlacklistHighlights('the config has "npm run build" as a script')).toEqual([]);
  });

  it("ignores commands in function calls with double quotes", () => {
    expect(getContentBlacklistHighlights('the script calls execSync("npm run build")')).toEqual([]);
  });

  it("still catches bare unquoted command instructions", () => {
    const highlights = getContentBlacklistHighlights("Run just build to verify");
    expect(highlights.length).toBe(1);
    expect(highlights[0]).toContain("just build");
  });

  it("still catches commands outside quotes on same line", () => {
    const highlights = getContentBlacklistHighlights('After "setup", run npm run build');
    expect(highlights.length).toBe(1);
  });

  it("ignores commands inside backticks (existing behavior)", () => {
    expect(getContentBlacklistHighlights("Remove `npm run build` from the docs")).toEqual([]);
  });
});

describe("getBlacklistHighlights", () => {
  it("returns empty array for non-Bash tool", () => {
    expect(getBlacklistHighlights("Read", { file_path: "/etc/passwd" })).toEqual([]);
  });

  it("returns empty array for Bash with no command", () => {
    expect(getBlacklistHighlights("Bash", {})).toEqual([]);
  });

  it("detects 'cat /etc/passwd' in Bash command", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "cat /etc/passwd" });
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0]).toContain("BLACKLIST");
    expect(highlights[0]).toContain("cat");
  });

  it("detects 'tsc' in Bash command", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "tsc --noEmit" });
    expect(highlights.length).toBeGreaterThan(0);
  });

  it("returns multiple violations for compound command", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "cd /tmp && cat file.txt" });
    expect(highlights.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array for safe Bash command", () => {
    expect(getBlacklistHighlights("Bash", { command: "ls -la" })).toEqual([]);
  });

  it("detects 'vitest' in Bash command", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "npx vitest run" });
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0]).toContain("test command");
  });

  it("detects 'jest' in Bash command", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "npx jest --coverage" });
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0]).toContain("test command");
  });

  it("detects 'pytest' in Bash command", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "pytest tests/" });
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0]).toContain("test command");
  });
});

describe("getBlacklistHighlights - Agent background blocking", () => {
  it("blocks Agent with run_in_background: true", () => {
    const highlights = getBlacklistHighlights("Agent", { prompt: "do stuff", run_in_background: true });
    expect(highlights).toHaveLength(1);
    expect(highlights[0]).toContain("BLACKLIST");
    expect(highlights[0]).toContain("background agent");
  });

  it("allows Agent with run_in_background: false", () => {
    expect(getBlacklistHighlights("Agent", { prompt: "do stuff", run_in_background: false })).toEqual([]);
  });

  it("allows Agent with run_in_background omitted", () => {
    expect(getBlacklistHighlights("Agent", { prompt: "do stuff" })).toEqual([]);
  });
});

describe("detectWorkaroundPattern", () => {
  it("returns null for non-Bash tool", () => {
    expect(detectWorkaroundPattern("Read", { file_path: "/tmp" })).toBeNull();
  });

  it("returns 'type-check' for 'tsc' command", () => {
    expect(detectWorkaroundPattern("Bash", { command: "tsc --noEmit" })).toBe("type-check");
  });

  it("returns 'build' for 'npm run build'", () => {
    expect(detectWorkaroundPattern("Bash", { command: "npm run build" })).toBe("build");
  });

  it("returns 'lint' for 'eslint'", () => {
    expect(detectWorkaroundPattern("Bash", { command: "eslint src/" })).toBe("lint");
  });

  it("returns 'test' for command containing 'test'", () => {
    expect(detectWorkaroundPattern("Bash", { command: "npm test" })).toBe("test");
  });

  it("returns 'install' for 'npm install'", () => {
    expect(detectWorkaroundPattern("Bash", { command: "npm install express" })).toBe("install");
  });

  it("returns 'code-exec' for 'python ' command", () => {
    expect(detectWorkaroundPattern("Bash", { command: "python script.py" })).toBe("code-exec");
  });

  it("returns null for clean Bash command", () => {
    expect(detectWorkaroundPattern("Bash", { command: "ls -la" })).toBeNull();
  });

  it("returns null for Bash with empty command", () => {
    expect(detectWorkaroundPattern("Bash", { command: "" })).toBeNull();
  });

  it("returns 'test' for 'vitest' command", () => {
    expect(detectWorkaroundPattern("Bash", { command: "vitest run" })).toBe("test");
  });

  it("returns 'test' for 'jest' command", () => {
    expect(detectWorkaroundPattern("Bash", { command: "jest --coverage" })).toBe("test");
  });
});
