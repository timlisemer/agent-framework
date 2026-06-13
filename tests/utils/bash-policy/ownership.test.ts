import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateBashPolicy } from "../../../src/utils/bash-command-policy.js";

const POLICY_MATRIX_COMMANDS = [
  "git status --short",
  "git push",
  "npx --yes tsc --noEmit",
  "bash -lc 'npx tsc --noEmit'",
  "echo hi > out.txt",
  "tee out.txt",
  "node script.js",
  "npm install express",
  "ssh host uptime",
  "find . -delete",
  "sed -i 's/a/b/' file.txt",
  "rg -n foo src",
  "cat file | head -10",
  "curl https://example.com",
];

function productionSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (fullPath.endsWith(path.join("src", "utils", "bash-policy"))) continue;
      files.push(...productionSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("bash policy ownership", () => {
  it("returns exactly one terminal decision for policy matrix commands", () => {
    for (const command of POLICY_MATRIX_COMMANDS) {
      const result = evaluateBashPolicy(command);

      expect(result.terminal, command).toBeDefined();
      expect(Array.isArray(result.observations), command).toBe(true);
      expect(result.observations.filter((finding) => finding.role === "terminal-candidate").length, command).toBeLessThanOrEqual(1);
    }
  });

  it.each([
    ['bash -lc "tee out.txt"', "file-write", "tee file write", "blocked"],
    ['bash -lc "python -c print(1)"', "script-exec", "python", "blocked"],
    ['xargs sh -c "npm install express"', "run-install-remote", "npm install", "high-risk-workaround"],
    ['xargs sh -c "echo hi > out.txt"', "file-write", "shell redirect", "blocked"],
    ['bash -lc "xargs git push"', "git", "git write op (MCP)", "blocked"],
    ["xargs xargs find . -delete", "find-sed", "find destructive flag", "blocked"],
  ])("applies blacklist ownership inside wrapped payloads: %s", (command, ownerTopic, ownerName, riskClass) => {
    const result = evaluateBashPolicy(command);

    expect(result.terminal.ownerTopic).toBe(ownerTopic);
    expect(result.terminal.ownerName).toBe(ownerName);
    expect(result.terminal.riskClass).toBe(riskClass);
  });

  it("does not let a later check-routed segment own an unsafe mixed command", () => {
    const result = evaluateBashPolicy("curl https://example.com && npx tsc --noEmit");

    expect(result.terminal.ownerTopic).not.toBe("check-routed");
    expect(result.terminal.riskClass).toBe("non-read-only-non-workaround");
  });

  it("does not let a wrapped mixed payload become check-routed", () => {
    const result = evaluateBashPolicy('bash -lc "curl https://example.com && npx tsc --noEmit"');

    expect(result.terminal.ownerTopic).not.toBe("check-routed");
    expect(result.terminal.riskClass).toBe("non-read-only-non-workaround");
  });

  it.each([
    "git push && npm install express",
    "echo hi > out.txt && npm install express",
  ])("preserves install workaround signal in mixed direct-deny commands: %s", (command) => {
    const result = evaluateBashPolicy(command);

    expect(result.terminal.riskClass).toBe("blocked");
    expect(result.terminal.workaroundCategory).toBe("install");
  });

  it("does not attach install workaround state to read-only hard blocks", () => {
    const result = evaluateBashPolicy("cd /tmp && npm install express");

    expect(result.terminal.ownerName).toBe("cd");
    expect(result.terminal.ownerTopic).toBe("read-only");
    expect(result.terminal.workaroundCategory).toBeUndefined();
  });

  it("keeps production consumers out of topic internals", () => {
    const srcRoot = path.join(process.cwd(), "src");
    const offenders = productionSourceFiles(srcRoot).filter((filePath) => {
      if (filePath.endsWith(path.join("src", "utils", "find-command-policy.ts"))) return false;
      if (filePath.endsWith(path.join("src", "utils", "bash-command-policy.ts"))) return false;
      const content = fs.readFileSync(filePath, "utf8");
      return /from\s+["'][^"']*bash-policy\/topics\//.test(content) ||
        /import\(\s*["'][^"']*bash-policy\/topics\//.test(content);
    });

    expect(offenders.map((filePath) => path.relative(process.cwd(), filePath))).toEqual([]);
  });
});
