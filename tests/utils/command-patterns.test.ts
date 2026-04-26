import { describe, it, expect } from "vitest";
import {
  BLACKLIST_PATTERNS,
  getBlacklistDescription,
  getContentBlacklistHighlights,
  getBlacklistHighlights,
  detectWorkaroundPattern,
} from "../../src/utils/command-patterns.js";
import { redactPathTokens } from "../../src/utils/path-redaction.js";

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
    expect(highlights[0].rendered).toContain("cat");
    expect(highlights[0].rendered).toContain("VIOLATION");
  });

  it("does NOT flag 'grep pattern' in content (bash grep is allowed post-v2.1.117)", () => {
    expect(getContentBlacklistHighlights("grep -r 'foo' .")).toEqual([]);
  });

  it("does NOT flag 'find' in content (bash find is allowed post-v2.1.117)", () => {
    expect(getContentBlacklistHighlights("find . -name '*.ts'")).toEqual([]);
  });

  it("detects 'git commit' in content", () => {
    const highlights = getContentBlacklistHighlights("git commit -m 'fix'");
    expect(highlights.length).toBe(1);
    expect(highlights[0].rendered).toContain("git write op");
  });

  it("detects 'npm install' in content", () => {
    const highlights = getContentBlacklistHighlights("npm install express");
    expect(highlights.length).toBe(1);
    expect(highlights[0].rendered).toContain("npm install");
  });

  it("returns one highlight per line (not per pattern)", () => {
    const highlights = getContentBlacklistHighlights("cat somefile\ngit commit -m 'x'");
    expect(highlights).toHaveLength(2);
  });

  it("detects 'tsc' in content", () => {
    const highlights = getContentBlacklistHighlights("npx tsc --noEmit");
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0].rendered).toContain("tsc");
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
    expect(highlights[0].rendered).toContain("just build");
  });

  it("still catches commands outside quotes on same line", () => {
    const highlights = getContentBlacklistHighlights('After "setup", run npm run build');
    expect(highlights.length).toBe(1);
  });

  it("ignores commands inside backticks (existing behavior)", () => {
    expect(getContentBlacklistHighlights("Remove `npm run build` from the docs")).toEqual([]);
  });

  describe("inverseCodeBlocks mode", () => {
    it("detects fenced `make build` in code block", () => {
      const content = "Some prose.\n\n```bash\nmake build\n```\n";
      const hits = getContentBlacklistHighlights(content, { inverseCodeBlocks: true });
      expect(hits.length).toBe(1);
      expect(hits[0].rendered).toContain("make build");
    });

    it("does NOT detect prose `make build` in inverseCodeBlocks mode", () => {
      const content = "We do not run make build in this project.";
      const hits = getContentBlacklistHighlights(content, { inverseCodeBlocks: true });
      expect(hits).toEqual([]);
    });

    it("default mode (outside code blocks) does NOT match commands inside fenced blocks", () => {
      const content = "Some prose.\n\n```bash\nmake build\n```\n";
      const hits = getContentBlacklistHighlights(content);
      expect(hits).toEqual([]);
    });
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

describe("getBlacklistHighlights path redaction regression", () => {
  it("does not false-fire 'test command' on 'ls test-harness/'", () => {
    expect(getBlacklistHighlights("Bash", { command: "ls test-harness/" })).toEqual([]);
  });

  it("does not false-fire on 'rm -rf test-harness/fixtures'", () => {
    expect(getBlacklistHighlights("Bash", { command: "rm -rf test-harness/fixtures" })).toEqual([]);
  });

  it("does not false-fire on 'ls ./test-harness'", () => {
    expect(getBlacklistHighlights("Bash", { command: "ls ./test-harness" })).toEqual([]);
  });

  it("does not false-fire on 'ls @test-harness/'", () => {
    expect(getBlacklistHighlights("Bash", { command: "ls @test-harness/" })).toEqual([]);
  });

  it("does not false-fire on 'ls test-harness' (no trailing slash)", () => {
    expect(getBlacklistHighlights("Bash", { command: "ls test-harness" })).toEqual([]);
  });

  it("does not false-fire on 'stat /home/tim/Coding/test-harness'", () => {
    expect(getBlacklistHighlights("Bash", { command: "stat /home/tim/Coding/test-harness" })).toEqual([]);
  });

  it("does not false-fire 'cargo build' on 'ls ./build/'", () => {
    expect(getBlacklistHighlights("Bash", { command: "ls ./build/" })).toEqual([]);
  });

  it("does not false-fire 'node' on 'ls node_modules/'", () => {
    expect(getBlacklistHighlights("Bash", { command: "ls node_modules/" })).toEqual([]);
  });

  it("still fires 'test command' on 'cargo test'", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "cargo test" });
    expect(highlights.some((h) => h.includes("[BLACKLIST: test command]"))).toBe(true);
  });

  it("still fires 'test command' on 'npm test'", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "npm test" });
    expect(highlights.some((h) => h.includes("[BLACKLIST: test command]"))).toBe(true);
  });

  it("still fires 'test command' on 'npx vitest run'", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "npx vitest run" });
    expect(highlights.some((h) => h.includes("[BLACKLIST: test command]"))).toBe(true);
  });

  it("still fires 'test command' on 'pytest tests/unit/test_foo.py'", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "pytest tests/unit/test_foo.py" });
    expect(highlights.some((h) => h.includes("[BLACKLIST: test command]"))).toBe(true);
  });

  it("still fires 'cd' on 'cd test-harness/' (path-sensitive pattern)", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "cd test-harness/" });
    expect(highlights.some((h) => h.includes("[BLACKLIST: cd]"))).toBe(true);
  });

  it("still fires 'cat' on 'cat test-harness/file.txt' (path-sensitive pattern)", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "cat test-harness/file.txt" });
    expect(highlights.some((h) => h.includes("[BLACKLIST: cat]"))).toBe(true);
  });

  it("still fires 'echo redirect' on 'echo hi > test-harness/out.log'", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "echo hi > test-harness/out.log" });
    expect(highlights.some((h) => h.includes("[BLACKLIST: echo redirect]"))).toBe(true);
  });
});

describe("getContentBlacklistHighlights path redaction", () => {
  it("does not false-fire build pattern on './build/output.txt'", () => {
    expect(getContentBlacklistHighlights("See ./build/output.txt")).toEqual([]);
  });

  it("does not false-fire node pattern on 'node_modules/foo.js'", () => {
    expect(getContentBlacklistHighlights("Check node_modules/foo.js in the plan")).toEqual([]);
  });
});

describe("filterBlacklistOutsideManualVerification + heading helpers", () => {
  // Imported here to avoid touching unrelated imports above.
  // Using dynamic require would be cleaner but vitest handles ESM fine.
  it("findManualVerificationRange returns null when no heading", async () => {
    const { findManualVerificationRange } = await import(
      "../../src/utils/content-patterns.js"
    );
    expect(findManualVerificationRange("# Plan\n\n## Implementation\n")).toBeNull();
  });

  it("findManualVerificationRange spans to next same-level heading", async () => {
    const { findManualVerificationRange } = await import(
      "../../src/utils/content-patterns.js"
    );
    const md = `# Plan
## Implementation
do stuff
## Manual User Verification
make build
## Notes
hello
`;
    const range = findManualVerificationRange(md);
    expect(range).not.toBeNull();
    expect(md.slice(range!.start, range!.end)).toContain("make build");
    expect(md.slice(range!.start, range!.end)).not.toContain("hello");
  });

  it("filterBlacklistOutsideManualVerification removes hits inside the section", async () => {
    const {
      filterBlacklistOutsideManualVerification,
    } = await import("../../src/utils/content-patterns.js");
    const md = `# Plan
## Manual User Verification
make build
`;
    const hits = getContentBlacklistHighlights(md);
    const filtered = filterBlacklistOutsideManualVerification(hits, md);
    expect(filtered).toEqual([]);
  });

  it("filterBlacklistOutsideManualVerification keeps hits outside the section", async () => {
    const {
      filterBlacklistOutsideManualVerification,
    } = await import("../../src/utils/content-patterns.js");
    const md = `# Plan
make build now
## Manual User Verification
ssh server uptime
`;
    const hits = getContentBlacklistHighlights(md);
    const filtered = filterBlacklistOutsideManualVerification(hits, md);
    expect(filtered.length).toBe(1);
    expect(filtered[0].rendered).toContain("make build");
  });

  it("EOF-terminated section is recognized correctly", async () => {
    const {
      findManualVerificationRange,
      filterBlacklistOutsideManualVerification,
    } = await import("../../src/utils/content-patterns.js");
    const md = `# Plan
## Manual User Verification
make build at the end
`;
    const range = findManualVerificationRange(md);
    expect(range).not.toBeNull();
    expect(range!.end).toBe(md.length);
    const hits = getContentBlacklistHighlights(md);
    const filtered = filterBlacklistOutsideManualVerification(hits, md);
    expect(filtered).toEqual([]);
  });

  it("matches Manual Verification (without User) heading per existing regex", async () => {
    const { findManualVerificationRange } = await import(
      "../../src/utils/content-patterns.js"
    );
    const md = `## Manual Verification
make build
`;
    const range = findManualVerificationRange(md);
    expect(range).not.toBeNull();
  });
});

describe("BLACKLIST_PATTERNS invariant guard", () => {
  it("no verb-only blacklist pattern has a path-like source string", () => {
    // Guards against future hyphenated verbs (docker-compose, apt-get, etc.) silently
    // becoming <PATH> under rule 6 and no longer firing.
    for (const { name, redactPaths } of BLACKLIST_PATTERNS) {
      if (!redactPaths) continue;
      const verb = name.split(/\s+/)[0]; // e.g. "cargo build" → "cargo"
      expect(redactPathTokens(verb), `verb '${verb}' from pattern '${name}'`).toBe(verb);
    }
  });
});
