import { describe, it, expect } from "vitest";
import {
  BLACKLIST_PATTERNS,
  getBlacklistDescription,
  getContentBlacklistHighlights,
  getBlacklistHighlights,
  detectWorkaroundPattern,
  checkReadOnlyBashAllowlist,
  getCheckRoutedCommandHighlights,
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

describe("checkReadOnlyBashAllowlist", () => {
  it("allows existing read-only command heads and simple pipelines", () => {
    expect(checkReadOnlyBashAllowlist("rg -n foo src").allowed).toBe(true);
    expect(checkReadOnlyBashAllowlist("find src -name '*.ts' | wc -l").allowed).toBe(true);
    expect(checkReadOnlyBashAllowlist("ls && pwd").allowed).toBe(true);
  });

  it("allows expanded read-only investigation commands", () => {
    for (const command of [
      "cat package.json",
      "sed -n '1,80p' src/index.ts",
      "awk '{print $1}' package.json",
      "nl -ba src/index.ts",
      "find src -name '*.ts' | xargs grep -l foo",
      "git status --short",
      "git diff -- src/index.ts",
      "git show HEAD:package.json",
    ]) {
      expect(checkReadOnlyBashAllowlist(command).allowed).toBe(true);
    }
  });

  it("denies commands outside the read-only allowlist", () => {
    const result = checkReadOnlyBashAllowlist("npm run build");
    expect(result.allowed).toBe(false);
  });

  it("denies read-only-looking commands with mutation-capable shell features", () => {
    expect(checkReadOnlyBashAllowlist("find . -delete").allowed).toBe(false);
    expect(checkReadOnlyBashAllowlist("rg foo > out.txt").allowed).toBe(false);
    expect(checkReadOnlyBashAllowlist("rg $(pwd)").allowed).toBe(false);
    expect(checkReadOnlyBashAllowlist("cd src && rg -n foo .").allowed).toBe(false);
    expect(checkReadOnlyBashAllowlist("sed -i 's/a/b/' file.txt").allowed).toBe(false);
    expect(checkReadOnlyBashAllowlist("git push").allowed).toBe(false);
    expect(checkReadOnlyBashAllowlist("git add .").allowed).toBe(false);
    expect(checkReadOnlyBashAllowlist("find . -name '*.ts' | xargs node").allowed).toBe(false);
  });
});

describe("getContentBlacklistHighlights", () => {
  it("returns empty array for clean content", () => {
    expect(getContentBlacklistHighlights("const x = 1;\nreturn x;")).toEqual([]);
  });

  it("does NOT flag 'cat somefile' in content", () => {
    expect(getContentBlacklistHighlights("cat /etc/passwd")).toEqual([]);
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
    const highlights = getContentBlacklistHighlights("npm install express\ngit commit -m 'x'");
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

  it("does NOT flag 'cat /etc/passwd' in Bash command", () => {
    expect(getBlacklistHighlights("Bash", { command: "cat /etc/passwd" })).toEqual([]);
  });

  it("routes 'tsc' Bash command through check-routed policy", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "tsc --noEmit" });
    expect(highlights.length).toBeGreaterThan(0);
    expect(getBlacklistHighlights("Bash", { command: "tsc --noEmit" })).toEqual(highlights);
  });

  it("detects 'nix eval' in Bash command and points to nix-eval-jobs", () => {
    const highlights = getBlacklistHighlights("Bash", {
      command: "nix eval .#nixosConfigurations.host.config.system.build.toplevel",
    });
    expect(highlights.some((h) => h.includes("[BLACKLIST: nix eval]"))).toBe(true);
    expect(highlights.some((h) => h.includes("Use nix-eval-jobs instead"))).toBe(true);
  });

  it("returns multiple violations for compound command", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "cd /tmp && git push" });
    expect(highlights.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array for safe Bash command", () => {
    expect(getBlacklistHighlights("Bash", { command: "ls -la" })).toEqual([]);
  });

  it("allows read-only git inspection commands", () => {
    for (const command of ["git status", "git diff", "git log --oneline", "git show HEAD"]) {
      expect(getBlacklistHighlights("Bash", { command })).toEqual([]);
    }
  });

  it("blocks raw git write operations", () => {
    for (const command of ["git add .", "git commit -m fix", "git push", "git reset --hard", "git merge main"]) {
      const highlights = getBlacklistHighlights("Bash", { command });
      expect(highlights.some((h) => h.includes("git write op"))).toBe(true);
    }
  });

  it("does not scan rg search text as executable git intent", () => {
    expect(
      getBlacklistHighlights("Bash", {
        command: `rg -n "git write op|Git write operation" src tests`,
      }),
    ).toEqual([]);
  });

  it("routes 'vitest' Bash command through check-routed policy", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "npx vitest run" });
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0]).toContain("test command");
  });

  it("routes 'jest' Bash command through check-routed policy", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "npx jest --coverage" });
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0]).toContain("test command");
  });

  it("routes 'pytest' Bash command through check-routed policy", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "pytest tests/" });
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0]).toContain("test command");
  });

  it("does not false-fire 'tail' on word inside string literal in node -e", () => {
    const cmd = `node -e 'console.log("Capture the tail in the enriched sentinel")'`;
    const highlights = getBlacklistHighlights("Bash", { command: cmd });
    expect(highlights.some((h) => h.includes("[BLACKLIST: tail]"))).toBe(false);
    expect(highlights.some((h) => h.includes("Use Read tool with offset"))).toBe(false);
    expect(highlights.some((h) => h.includes("[BLACKLIST: node]"))).toBe(true);
  });

  it("does not false-fire 'cat' on word inside double-quoted argument", () => {
    expect(
      getBlacklistHighlights("Bash", { command: `echo "the cat sat on the mat"` })
    ).toEqual([]);
  });

  it("does not false-fire 'head' on word inside python -c argument", () => {
    const highlights = getBlacklistHighlights("Bash", {
      command: `python3 -c "print('head of list')"`,
    });
    expect(highlights.some((h) => h.includes("[BLACKLIST: head]"))).toBe(false);
    expect(highlights.some((h) => h.includes("[BLACKLIST: python3]"))).toBe(true);
  });

  it("does NOT fire 'tail' when invoked as the executable", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "tail -n 10 server.log" });
    expect(highlights.some((h) => h.includes("[BLACKLIST: tail]"))).toBe(false);
  });

  it("does NOT fire 'head' on bare 'head -n 50 file.log'", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "head -n 50 file.log" });
    expect(highlights.some((h) => h.includes("[BLACKLIST: head]"))).toBe(false);
  });

  it("still treats 'ls | head -5' as output truncation (pipe is not a segment separator)", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "ls | head -5" });
    expect(highlights.some((h) => h.includes("[BLACKLIST: head]"))).toBe(false);
  });

  it("does NOT fire 'cat' on the second segment of a sequence command", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "ls /tmp; cat /etc/hosts" });
    expect(highlights.some((h) => h.includes("[BLACKLIST: cat]"))).toBe(false);
  });

  it("does not get fragmented by separators inside string literals", () => {
    const highlights = getBlacklistHighlights("Bash", {
      command: `python3 -c "import os; tail = 5"`,
    });
    expect(highlights.some((h) => h.includes("[BLACKLIST: tail]"))).toBe(false);
  });

  it("preserves 2>&1 redirection semantics: `cmd 2>&1 | tail -80` does not fire 'tail'", () => {
    const highlights = getBlacklistHighlights("Bash", {
      command: "ls dist/mcp/server.js 2>&1 | tail -80",
    });
    expect(highlights.some((h) => h.includes("[BLACKLIST: tail]"))).toBe(false);
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

  it("does not treat quoted search text or test paths as workaround commands", () => {
    expect(detectWorkaroundPattern("Bash", {
      command: `rg -n "npm test|vitest" tests src`,
    })).toBeNull();
    expect(detectWorkaroundPattern("Bash", {
      command: `find . -name "*.test.ts"`,
    })).toBeNull();
  });

  it("returns 'install' for 'npm install'", () => {
    expect(detectWorkaroundPattern("Bash", { command: "npm install express" })).toBe("install");
  });

  it("does not treat scripting language execution as a check-MCP workaround", () => {
    expect(detectWorkaroundPattern("Bash", { command: "python script.py" })).toBeNull();
    expect(detectWorkaroundPattern("Bash", { command: "node" })).toBeNull();
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

  it("still blocks bare scripting language commands without check MCP redirect", () => {
    for (const command of ["node", "python", "perl"]) {
      const highlights = getBlacklistHighlights("Bash", { command });
      expect(highlights.some((h) => h.includes(`[BLACKLIST: ${command}]`))).toBe(true);
      expect(highlights.some((h) => h.includes("Scripting language execution denied"))).toBe(true);
      expect(highlights.some((h) => h.includes("check MCP"))).toBe(false);
    }
  });

  it("routes 'test command' on 'cargo test'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "cargo test" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  it("routes 'test command' on 'npm test'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "npm test" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  it("routes 'test command' on 'npx vitest run'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "npx vitest run" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  it("routes 'test command' on 'pytest tests/unit/test_foo.py'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "pytest tests/unit/test_foo.py" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  it("still fires 'cd' on 'cd test-harness/' (path-sensitive pattern)", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "cd test-harness/" });
    expect(highlights.some((h) => h.includes("[BLACKLIST: cd]"))).toBe(true);
  });

  it("does NOT fire 'cat' on 'cat test-harness/file.txt'", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "cat test-harness/file.txt" });
    expect(highlights.some((h) => h.includes("[BLACKLIST: cat]"))).toBe(false);
  });

  it("still fires 'echo redirect' on 'echo hi > test-harness/out.log'", () => {
    const highlights = getBlacklistHighlights("Bash", { command: "echo hi > test-harness/out.log" });
    expect(highlights.some((h) => h.includes("[BLACKLIST: echo redirect]"))).toBe(true);
  });

  // Negative cases: find/grep with *.test.ts arguments must NOT fire "test command"
  it("does not false-fire 'test command' on find with *.test.ts argument (failing scenario exact command)", () => {
    const cmd = `find /home/tim/Coding/public_repos/agent-framework/src -name "*.test.ts" -path "*/src/*" | xargs grep -l "..."`;
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: cmd });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(false);
  });

  it("does not false-fire 'test command' on 'find . -name \"foo.test.ts\"'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: `find . -name "foo.test.ts"` });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(false);
  });

  it("does not false-fire 'test command' on 'ls my-test.txt'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "ls my-test.txt" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(false);
  });

  it("does not false-fire 'test command' on 'grep -rn \"test\" .'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: `grep -rn "test" .` });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(false);
  });

  // Positive cases: npm-family package manager forms must still fire
  it("still fires 'test command' on 'npm run test'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "npm run test" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  it("still fires 'test command' on 'yarn test'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "yarn test" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  it("still fires 'test command' on 'yarn run test'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "yarn run test" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  it("still fires 'test command' on 'pnpm test'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "pnpm test" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  it("still fires 'test command' on 'pnpm run test'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "pnpm run test" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  it("still fires 'test command' on 'bun test'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "bun test" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  it("still fires 'test command' on 'bun run test'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "bun run test" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  it("still fires 'test command' on 'npx test'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "npx test" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  // Positive cases: bare runner binary names must still fire
  it("still fires 'test command' on 'vitest run'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "vitest run" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  it("still fires 'test command' on 'jest --coverage'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "jest --coverage" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  it("still fires 'test command' on 'mocha'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "mocha" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });

  it("still fires 'test command' on 'ava'", () => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command: "ava" });
    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: test command]"))).toBe(true);
  });
});

describe("getContentBlacklistHighlights path redaction", () => {
  it("does not false-fire build pattern on './build/output.txt'", () => {
    expect(getContentBlacklistHighlights("See ./build/output.txt")).toEqual([]);
  });

  it("does not false-fire node pattern on 'node_modules/foo.js'", () => {
    expect(getContentBlacklistHighlights("Check node_modules/foo.js in the plan")).toEqual([]);
  });

  it("does not false-fire node pattern on prose phrase 'node with'", () => {
    const plan = "- submenu node with children-display and 2 leaves.";
    expect(getContentBlacklistHighlights(plan)).toEqual([]);
  });

  it("does not false-fire tail pattern on prose phrase 'tail events'", () => {
    const plan = "- For variable-length tail events, split off fixed prefix fields.";
    expect(getContentBlacklistHighlights(plan)).toEqual([]);
  });

  it("does not false-fire tsc pattern on bare word in parenthesised prose", () => {
    const plan = "Tier-A scanner plus tsc plus tests gates the merge.";
    expect(getContentBlacklistHighlights(plan)).toEqual([]);
  });

  it("still fires node pattern on a real `node script.js` invocation in plan prose", () => {
    const highlights = getContentBlacklistHighlights("Run node script.js to bootstrap the demo.");
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0].rendered).toContain("[VIOLATION: node]");
  });

  it("does NOT fire tail pattern on a real `tail -n 20 server.log` invocation in plan prose", () => {
    const highlights = getContentBlacklistHighlights("Run tail -n 20 server.log to inspect the trailing lines.");
    expect(highlights).toEqual([]);
  });

  it("still fires tsc pattern on a real `npx tsc` invocation in plan prose", () => {
    const highlights = getContentBlacklistHighlights("Run npx tsc to typecheck before merging.");
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0].rendered).toContain("[VIOLATION: tsc]");
  });

  it("still fires nix eval pattern on a real invocation in plan prose", () => {
    const highlights = getContentBlacklistHighlights("Run nix eval .#checks.x86_64-linux before merging.");
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0].rendered).toContain("[VIOLATION: nix eval]");
    expect(highlights[0].rendered).toContain("Use nix-eval-jobs instead");
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
