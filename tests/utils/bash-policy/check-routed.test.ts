import { describe, expect, it } from "vitest";
import {
  evaluateBashPolicy,
  getCheckRoutedCommandHighlights,
} from "../../../src/utils/bash-command-policy.js";

describe("check-routed bash policy", () => {
  it.each([
    "tsc --noEmit",
    "npx tsc --noEmit",
    "npx --yes tsc --noEmit",
    "npx -y tsc --noEmit",
    "npx --package typescript tsc --noEmit",
    "npm exec tsc -- --noEmit",
    "npm exec --package typescript tsc --noEmit",
    "pnpm exec tsc --noEmit",
    "yarn exec tsc --noEmit",
    "bunx tsc --noEmit",
    "bunx --yes tsc --noEmit",
    'bash -lc "npx tsc --noEmit"',
    "sh -c 'npx --yes tsc --noEmit'",
    "eval 'npx tsc --noEmit'",
  ])("routes TypeScript executable form through check MCP: %s", (command) => {
    const highlights = getCheckRoutedCommandHighlights("Bash", { command });
    const result = evaluateBashPolicy(command);

    expect(highlights.some((h) => h.includes("[CHECK-ROUTED: tsc]"))).toBe(true);
    expect(result.terminal.ownerTopic).toBe("check-routed");
    expect(result.terminal.riskClass).toBe("high-risk-workaround");
  });

  it.each([
    "cargo +nightly check",
    "cargo +stable build",
    "cargo +1.85.0 clippy",
    "cargo +nightly test",
    "cargo +nightly fmt --check",
    "make -C subdir check",
    "just --justfile ./Justfile fmt",
    "just format",
    "make fmt",
    "npm run lint",
    "pnpm test",
    "npx vitest run",
  ])("routes current check/build/lint/test/format families: %s", (command) => {
    expect(getCheckRoutedCommandHighlights("Bash", { command }).length).toBeGreaterThan(0);
    expect(evaluateBashPolicy(command).terminal.ownerTopic).toBe("check-routed");
  });

  it.each([
    'rg "npx tsc --noEmit" src',
    'grep -rn "cargo test" .',
    'find . -name "*.test.ts"',
    "cat prettier.config.js",
    "ls format-report.txt",
  ])("does not route check words that are read-only arguments: %s", (command) => {
    expect(getCheckRoutedCommandHighlights("Bash", { command })).toEqual([]);
    expect(evaluateBashPolicy(command).terminal.ownerTopic).not.toBe("check-routed");
  });

  it("keeps install ownership when a mixed command also contains check-routed work", () => {
    const result = evaluateBashPolicy("npm install express && tsc --noEmit");

    expect(result.terminal.ownerTopic).toBe("run-install-remote");
    expect(result.terminal.ownerName).toBe("npm install");
    expect(result.terminal.riskClass).toBe("high-risk-workaround");
    expect(result.terminal.workaroundCategory).toBe("install");
  });

  it("keeps wrapped make and just check routing distinct", () => {
    const justHighlights = getCheckRoutedCommandHighlights("Bash", { command: 'bash -lc "just check"' });
    const makeHighlights = getCheckRoutedCommandHighlights("Bash", { command: 'bash -lc "make check"' });

    expect(justHighlights).toHaveLength(1);
    expect(justHighlights[0]).toContain("[CHECK-ROUTED: just check]");
    expect(makeHighlights).toHaveLength(1);
    expect(makeHighlights[0]).toContain("[CHECK-ROUTED: make check]");
    expect(evaluateBashPolicy('bash -lc "just check"').terminal.ownerName).toBe("just check");
    expect(evaluateBashPolicy('bash -lc "make check"').terminal.ownerName).toBe("make check");
  });

  it("routes deeply nested shell payloads without a fixed cutoff", () => {
    let command = "npx tsc --noEmit";
    for (let i = 0; i < 8; i++) {
      command = `bash -lc ${JSON.stringify(command)}`;
    }
    const result = evaluateBashPolicy(command);

    expect(result.terminal.ownerTopic).toBe("check-routed");
    expect(result.terminal.ownerName).toBe("tsc");
  });
});
