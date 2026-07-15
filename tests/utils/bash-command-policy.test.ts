import { describe, it, expect } from "vitest";
import {
  BLACKLIST_PATTERNS,
  CHECK_EQUIVALENTS,
  CHECK_ROUTED_COMMAND_POLICIES,
  READ_ONLY_BASH_COMMANDS,
  READ_ONLY_HEAVY_BASH_COMMANDS,
  WORKAROUND_PATTERNS,
  bashReadFileOperands,
  classifyBashCommand,
  getContentBlacklistHighlights,
  getCheckRoutedCommandHighlights,
  stripQuotedRegions,
} from "../../src/utils/bash-command-policy.js";
import {
  bashExpansionReadProofCases,
  bashDoesNotReadRequiredPathCommands,
  bashNoReadCapabilityCommands,
  bashReadCapabilityCommands,
  unsafeBashReadCommands,
} from "../helpers/bash-read-fixtures.js";
import {
  COMMAND_SUBSTITUTION_DENY_COMMAND_CASES,
  DESTRUCTIVE_READ_ONLY_COMMAND_DENY_CASES,
  FILE_REDIRECT_DENY_COMMAND_CASES,
  MUTATING_GIT_COMMAND_CASES,
  READ_ONLY_GIT_COMMAND_CASES,
  READ_ONLY_LITERAL_COMMAND_CASES,
} from "./bash-command-policy-cases.js";

describe("classifyBashCommand", () => {
  it("blocks nix eval and points to nix-eval-jobs", () => {
    const result = classifyBashCommand("nix eval .#nixosConfigurations.host.config.system.build.toplevel");
    expect(result.riskClass).toBe("blocked");
    expect(result.workaroundCategory).toBeUndefined();
    expect(result.reason).toBe("Use nix-eval-jobs instead");
    expect(result.alternative).toBe("Use nix-eval-jobs instead");
    expect(result.blacklistHighlights.some((h) => h.includes("[BLACKLIST: nix eval]"))).toBe(true);
  });

  it("classifies nix-eval-jobs as read-only-heavy", () => {
    const result = classifyBashCommand("nix-eval-jobs --flake .#nixosConfigurations.tim-server.config.system.build.toplevel --workers 1");
    expect(result.riskClass).toBe("read-only-heavy");
    expect(result.readOnly).toBe(true);
    expect(result.predictionIdentities).toContain("Bash:read-only-heavy");
    expect(result.predictionIdentities).toContain("Bash:nix-eval-jobs");
  });

  it("classifies rg as simple read-only", () => {
    expect(classifyBashCommand("rg -n foo src").riskClass).toBe("simple-read-only");
  });

  it("emits canonical Read capabilities only for safe file-content commands", () => {
    for (const command of bashReadCapabilityCommands("plan.md")) {
      const result = classifyBashCommand(command);
      expect(result.readOnly, command).toBe(true);
      expect(result.capabilities, command).toContainEqual({
        tool: "Read",
        input: { file_path: "plan.md", path: "plan.md" },
      });
      expect(result.predictionIdentities, command).not.toContain("Read");
    }

    for (const command of bashNoReadCapabilityCommands("plan.md")) {
      const result = classifyBashCommand(command);
      expect(result.capabilities, command).toEqual([]);
      expect(bashReadFileOperands(command), command).toEqual([]);
    }
  });

  it("reports only command-aware file operands", () => {
    const path = "plan.md";
    for (const command of bashDoesNotReadRequiredPathCommands(path)) {
      expect(bashReadFileOperands(command), command).not.toContain(path);
    }
    expect(bashReadFileOperands("cat 'plan file.md'")).toContain("plan file.md");
  });

  it("requires shell-expansion syntax in literal paths to be quoted", () => {
    for (const { literalPath, quotedCommand, unquotedCommand } of bashExpansionReadProofCases()) {
      expect(bashReadFileOperands(unquotedCommand), unquotedCommand).not.toContain(literalPath);
      expect(classifyBashCommand(unquotedCommand).capabilities, unquotedCommand)
        .toEqual([]);
      expect(bashReadFileOperands(quotedCommand), quotedCommand).toEqual([literalPath]);
      expect(classifyBashCommand(quotedCommand).capabilities, quotedCommand)
        .toContainEqual({
          tool: "Read",
          input: { file_path: literalPath, path: literalPath },
        });
    }
  });

  it("does not advertise canonical Read for unsafe file-content commands", () => {
    for (const command of unsafeBashReadCommands("plan.md")) {
      const result = classifyBashCommand(command);
      expect(result.readOnly, command).toBe(false);
      expect(result.capabilities, command).toEqual([]);
    }
  });

  it("classifies rg pattern with escaped quote and slash alternative as simple read-only", () => {
    const command =
      "rg -n \"href: '/config'|/config|Config'|Config\\\"|routes/config|configStore\" iocto-website/src";
    expect(classifyBashCommand(command).riskClass).toBe("simple-read-only");
  });

  it("classifies rg patterns containing angle-bracket text as read-only", () => {
    for (const command of READ_ONLY_LITERAL_COMMAND_CASES) {
      expect(classifyBashCommand(command).riskClass, command).toBe("simple-read-only");
    }
  });

  it("blocks command substitution inside double-quoted read-only command arguments", () => {
    for (const command of COMMAND_SUBSTITUTION_DENY_COMMAND_CASES) {
      const result = classifyBashCommand(command);
      expect(result.riskClass, command).toBe("blocked");
      expect(result.reason, command).toBe("command or process substitution ($(...), backticks, <(...), >(...))");
    }
  });

  it("blocks shell redirects with quoted or unquoted targets", () => {
    for (const command of FILE_REDIRECT_DENY_COMMAND_CASES) {
      const result = classifyBashCommand(command);
      expect(result.riskClass, command).toBe("blocked");
      expect(result.reason, command).toBe("shell redirect to file");
      expect(result.workaroundCategory, command).toBe("file-write");
    }
  });

  it("blocks deterministic file-write commands with file-write workaround metadata", () => {
    for (const command of [
      "dd if=/tmp/in of=/tmp/out",
      "install /tmp/source /tmp/target",
      "install -d /tmp/outdir",
      "install -t /tmp/outdir /tmp/source",
      "install -vtdest /tmp/source",
      "install --target-directory=/tmp/outdir /tmp/source",
      "cp /tmp/source /tmp/target",
      "cp -t /tmp/outdir /tmp/source",
      "cp -vtdest /tmp/source",
      "cp --target-directory=/tmp/outdir /tmp/source",
      "mv /tmp/source /tmp/target",
      "mv -t /tmp/outdir /tmp/source",
      "mv -vtdest /tmp/source",
      "mv --target-directory=/tmp/outdir /tmp/source",
    ]) {
      const result = classifyBashCommand(command);
      expect(result.riskClass, command).toBe("blocked");
      expect(result.reason, command).toContain("file write");
      expect(result.workaroundCategory, command).toBe("file-write");
    }
  });

  it("classifies background shell file writes before generic file-write findings", () => {
    for (const command of [
      "printf x > /tmp/out &",
      "bash -lc 'printf x > /tmp/out' &",
    ]) {
      const result = classifyBashCommand(command);
      expect(result.riskClass, command).toBe("blocked");
      expect(result.reason, command).toBe("background shell file write");
      expect(result.workaroundCategory, command).toBe("background-file-write");
    }
  });

  it("keeps foreground writes after unrelated background segments as file writes", () => {
    const result = classifyBashCommand("sleep 1 & printf x > /tmp/out");
    expect(result.riskClass).toBe("blocked");
    expect(result.reason).toBe("shell redirect to file");
    expect(result.workaroundCategory).toBe("file-write");
  });

  it("blocks destructive read-only command flags even when quoted", () => {
    for (const command of DESTRUCTIVE_READ_ONLY_COMMAND_DENY_CASES) {
      const result = classifyBashCommand(command);
      expect(result.riskClass, command).toBe("blocked");
    }
  });

  it("classifies safe read-only pipelines as read-only-complex", () => {
    expect(classifyBashCommand("cat file | grep x | head -20").riskClass).toBe("read-only-complex");
    expect(classifyBashCommand("rg -n foo src | head -50").riskClass).toBe("read-only-complex");
  });

  it("still blocks real relative path execution in a shell segment", () => {
    const result = classifyBashCommand("rg foo src | routes/config");
    expect(result.riskClass).toBe("blocked");
    expect(result.reason).toBe("relative path execution not allowed: routes/config");
  });

  it("classifies curl as non-read-only-non-workaround", () => {
    expect(classifyBashCommand("curl https://example.com").riskClass).toBe("non-read-only-non-workaround");
  });

  it("classifies build/test/lint/typecheck/format/install commands as high-risk-workaround", () => {
    for (const command of [
      "npm run build",
      "npm test",
      "npm run lint",
      "tsc --noEmit",
      "cargo fmt --check",
      "prettier --check src",
      "npm install express",
    ]) {
      expect(classifyBashCommand(command).riskClass).toBe("high-risk-workaround");
    }
  });

  it("blocks scripting language execution without treating it as check MCP workaround", () => {
    for (const command of ["node", "node script.js", "python", "python3 -c 'print(1)'", "perl", "ruby -e 'puts 1'"]) {
      const result = classifyBashCommand(command);
      expect(result.riskClass).toBe("blocked");
      expect(result.workaroundCategory).toBeUndefined();
      expect(result.alternative).toContain("Scripting language execution denied");
      expect(result.alternative).not.toContain("check MCP");
      expect(result.alternative).not.toContain("agent-framework-check");
    }
  });

  it("blocks unsafe nix-eval-jobs shell forms", () => {
    for (const command of [
      "nix-eval-jobs --flake .#x > out.json",
      "nix-eval-jobs $(pwd)",
      "FOO=1 nix-eval-jobs --flake .#x",
      "nix-eval-jobs --flake .#x &",
      "cd /tmp && nix-eval-jobs --flake .#x",
    ]) {
      expect(classifyBashCommand(command).riskClass).toBe("blocked");
    }
  });

  it("classifies common read-only git commands as simple read-only", () => {
    for (const command of READ_ONLY_GIT_COMMAND_CASES) {
      const result = classifyBashCommand(command);
      expect(result.riskClass, command).toBe("simple-read-only");
      expect(result.readOnly, command).toBe(true);
    }
  });

  it("blocks mutating git commands, including mixed subcommand families", () => {
    for (const command of MUTATING_GIT_COMMAND_CASES) {
      const result = classifyBashCommand(command);
      expect(result.riskClass, command).toBe("blocked");
      expect(result.reason, command).toContain("git write op");
    }
  });
});

describe("bash command policy invariants", () => {
  it("has no command head in contradictory read-only risk sets", () => {
    for (const command of READ_ONLY_HEAVY_BASH_COMMANDS) {
      expect(READ_ONLY_BASH_COMMANDS.has(command)).toBe(false);
    }
  });

  it("does not classify cd as read-only when it is blocked", () => {
    expect(READ_ONLY_BASH_COMMANDS.has("cd")).toBe(false);
    expect(classifyBashCommand("cd /tmp").riskClass).toBe("blocked");
  });

  it("keeps nix-eval-jobs out of blacklist, simple read-only, and high-risk workaround categories", () => {
    expect(BLACKLIST_PATTERNS.some((p) => p.pattern.test("nix-eval-jobs --flake .#x"))).toBe(false);
    expect(READ_ONLY_BASH_COMMANDS.has("nix-eval-jobs")).toBe(false);
    expect(classifyBashCommand("nix-eval-jobs --flake .#x").riskClass).toBe("read-only-heavy");
  });

  it("provides classification metadata for every high-risk workaround category", () => {
    for (const category of Object.keys(WORKAROUND_PATTERNS)) {
      const representative = WORKAROUND_PATTERNS[category].variants[0];
      const result = classifyBashCommand(representative);
      expect(result.riskClass).toBe("high-risk-workaround");
      expect(result.workaroundCategory).toBe(category);
    }
  });

  it("provides equivalents and workaround variants for every check-routed policy", () => {
    for (const policy of CHECK_ROUTED_COMMAND_POLICIES) {
      expect(policy.equivalents.length).toBeGreaterThan(0);
      expect(CHECK_EQUIVALENTS[policy.name]).toEqual(policy.equivalents);
      expect(WORKAROUND_PATTERNS[policy.category].variants).toEqual(
        expect.arrayContaining(policy.variants),
      );
    }
  });

  it("routes formatter commands through check-routed policy", () => {
    for (const command of [
      "cargo fmt --check",
      "rustfmt --check src/lib.rs",
      "prettier --check src",
      "npx prettier --check src",
      "npm run format",
      "pnpm fmt",
      "yarn run format",
      "bun run fmt",
      "make format",
      "just fmt",
      "biome check src",
      "dprint check",
      "treefmt --fail-on-change",
      "nix fmt",
      "alejandra .",
    ]) {
      const highlights = getCheckRoutedCommandHighlights("Bash", { command });
      expect(highlights.length).toBeGreaterThan(0);
      expect(highlights[0]).toContain("[CHECK-ROUTED:");
    }
  });

  it("does not route formatter names in read-only search text or filenames", () => {
    for (const command of [
      `rg prettier src`,
      `rg "cargo fmt" src`,
      `find . -name "*fmt*"`,
      "cat prettier.config.js",
      "ls format-report.txt",
    ]) {
      expect(getCheckRoutedCommandHighlights("Bash", { command })).toEqual([]);
    }
  });

  it("strips shell quoted regions with escaped double quotes before segment scanning", () => {
    const stripped = stripQuotedRegions(
      "rg -n \"href: '/config'|/config|Config'|Config\\\"|routes/config|configStore\" iocto-website/src",
    );
    expect(stripped).not.toContain("|routes/config");
    expect(stripped).toContain("rg -n");
    expect(stripped).toContain("iocto-website/src");
  });

  it("keeps content blacklist scanning semantics independent of Bash executable classification", () => {
    expect(getContentBlacklistHighlights('Remove `npm run build` from the docs')).toEqual([]);

    const codeBlockHits = getContentBlacklistHighlights("```bash\nnpm install express\n```", {
      inverseCodeBlocks: true,
    });
    expect(codeBlockHits[0].rendered).toContain("[VIOLATION: npm install]");

    const proseHits = getContentBlacklistHighlights("Run nix eval .#checks.x86_64-linux before merging.");
    expect(proseHits[0].rendered).toContain("[VIOLATION: nix eval]");
    expect(proseHits[0].rendered).toContain("Use nix-eval-jobs instead");

    expect(getContentBlacklistHighlights("Check node_modules/foo.js in the plan")).toEqual([]);
    expect(getContentBlacklistHighlights('the script calls execSync("npm run build")')).toEqual([]);
    expect(getContentBlacklistHighlights("Run git submodule status before inspecting nested diffs.")).toEqual([]);
    expect(getContentBlacklistHighlights("Run git submodule update before inspecting nested diffs.")[0].rendered).toContain("[VIOLATION: git write op]");
    expect(getContentBlacklistHighlights("Please git branch -d old-topic before merging.")[0].rendered).toContain("[VIOLATION: git write op]");
    expect(getContentBlacklistHighlights("Run git -C repo push before merging.")[0].rendered).toContain("[VIOLATION: git write op (MCP)]");
    expect(getContentBlacklistHighlights("Run git config edit before merging.")[0].rendered).toContain("[VIOLATION: git write op]");
    expect(getContentBlacklistHighlights("Run 'git push' before merging.")[0].rendered).toContain("[VIOLATION: git write op (MCP)]");
    expect(getContentBlacklistHighlights('```bash\nbash -lc "git push"\n```', { inverseCodeBlocks: true })[0].rendered).toContain("[VIOLATION: git write op (MCP)]");
  });
});
