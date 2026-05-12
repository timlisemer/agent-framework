import { describe, it, expect } from "vitest";
import {
  BLACKLIST_PATTERNS,
  READ_ONLY_BASH_COMMANDS,
  READ_ONLY_HEAVY_BASH_COMMANDS,
  WORKAROUND_PATTERNS,
  classifyBashCommand,
  getContentBlacklistHighlights,
} from "../../src/utils/bash-command-policy.js";

describe("classifyBashCommand", () => {
  it("blocks nix eval and points to nix-eval-jobs", () => {
    const result = classifyBashCommand("nix eval .#nixosConfigurations.host.config.system.build.toplevel");
    expect(result.riskClass).toBe("blocked");
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

  it("classifies safe read-only pipelines as read-only-complex", () => {
    expect(classifyBashCommand("cat file | grep x | head -20").riskClass).toBe("read-only-complex");
    expect(classifyBashCommand("rg -n foo src | head -50").riskClass).toBe("read-only-complex");
  });

  it("classifies curl as non-read-only-non-workaround", () => {
    expect(classifyBashCommand("curl https://example.com").riskClass).toBe("non-read-only-non-workaround");
  });

  it("classifies build/test/lint/typecheck/install commands as high-risk-workaround", () => {
    for (const command of [
      "npm run build",
      "npm test",
      "npm run lint",
      "tsc --noEmit",
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

  it("provides denial-cache/workaround metadata for every high-risk workaround category", () => {
    for (const category of Object.keys(WORKAROUND_PATTERNS)) {
      const representative = WORKAROUND_PATTERNS[category].variants[0];
      const result = classifyBashCommand(representative);
      expect(result.riskClass).toBe("high-risk-workaround");
      expect(result.workaroundCategory).toBe(category);
    }
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
  });
});
