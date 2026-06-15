import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { blacklistRule } from "../../src/rules/blacklist.js";
import { ALL_RULES } from "../../src/rules/index.js";
import { sessionStateDefaults } from "../../src/utils/session-store.js";
import { clearDenialCache, initDenialSession } from "../../src/utils/denial-cache.js";
import type { RuleContext } from "../../src/rules/types.js";
import { makeRuleContext } from "../helpers/rule-context.js";

function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return makeRuleContext({
    toolName: "Bash",
    toolInput: { command: "cd /tmp && ls" },
    toolUseId: "toolu_blacklist",
    projectDir: "/tmp/project",
    transcriptPath: "/tmp/transcript.jsonl",
    sessionDir: "/tmp/session",
    sessionId: "session",
    state: sessionStateDefaults(),
    stateManager: {
      update: vi.fn(),
    } as unknown as RuleContext["stateManager"],
    ...overrides,
  });
}

describe("blacklistRule", () => {
  it("fast-denies blacklisted Bash before prediction-block priority", async () => {
    const result = await blacklistRule.check(makeCtx());
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    expect((result as { fastDeny: string }).fastDeny).toContain("Use absolute paths");
  });

  it("still denies nix eval before prediction", async () => {
    const result = await blacklistRule.check(makeCtx({
      toolInput: { command: "nix eval .#checks.x86_64-linux" },
    }));
    expect(result).toEqual({ fastDeny: "Use nix-eval-jobs instead" });
  });

  it("owns check-routed command denials with check MCP wording", async () => {
    const result = await blacklistRule.check(makeCtx({
      toolInput: { command: "cargo fmt --check" },
    }));
    expect(result).toEqual({
      fastDeny: expect.stringContaining("agent-framework check MCP"),
    });
  });

  it("fast-denies check-routed Bash before prediction-block priority", async () => {
    const result = await blacklistRule.check(makeCtx({
      toolInput: { command: "npx vitest run tests/utils/prediction-types.test.ts" },
    }));
    expect(result).toEqual({
      fastDeny: expect.stringContaining("agent-framework check MCP"),
    });
  });

  it("owns npx tsc denials and marks check pending after confirmation", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blacklist-tsc-test-"));
    initDenialSession(tempDir);
    await clearDenialCache();
    const update = vi.fn();
    const ctx = makeCtx({
      toolInput: { command: "npx tsc --noEmit" },
      stateManager: { update } as unknown as RuleContext["stateManager"],
    });

    try {
      const result = await blacklistRule.check(ctx);
      expect(result).not.toBeNull();
      const fastDeny = (result as { fastDeny: string }).fastDeny;
      expect(fastDeny).toContain("tsc");
      expect(fastDeny).toContain("agent-framework check MCP");

      await blacklistRule.onDenialConfirmed?.(ctx, "tsc denied");
      expect(update).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("marks check pending for mixed direct-deny commands that contain install workarounds", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blacklist-install-test-"));
    initDenialSession(tempDir);
    await clearDenialCache();
    const update = vi.fn();
    const ctx = makeCtx({
      toolInput: { command: "git push && npm install express" },
      stateManager: { update } as unknown as RuleContext["stateManager"],
    });

    try {
      await blacklistRule.onDenialConfirmed?.(ctx, "git denied");
      expect(update).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not mark check pending for mixed non-read-only commands that contain check-routed work", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blacklist-mixed-check-test-"));
    initDenialSession(tempDir);
    await clearDenialCache();
    const update = vi.fn();
    const ctx = makeCtx({
      toolInput: { command: "curl https://example.com && npx tsc --noEmit" },
      stateManager: { update } as unknown as RuleContext["stateManager"],
    });

    try {
      await blacklistRule.onDenialConfirmed?.(ctx, "check denied");
      expect(update).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("sets forceCheckPending for denied workaround commands", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blacklist-test-"));
    initDenialSession(tempDir);
    await clearDenialCache();
    const update = vi.fn();
    const ctx = makeCtx({
      toolInput: { command: "cargo test -p astral-shell workspace_ordering" },
      stateManager: { update } as unknown as RuleContext["stateManager"],
    });

    try {
      await blacklistRule.onDenialConfirmed?.(ctx, "test command denied");
      expect(update).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not set forceCheckPending for denied nix-eval-jobs", async () => {
    const update = vi.fn();
    const ctx = makeCtx({
      toolInput: { command: "nix-eval-jobs --flake .#checks.x86_64-linux --workers 1" },
      stateManager: { update } as unknown as RuleContext["stateManager"],
    });

    await blacklistRule.onDenialConfirmed?.(ctx, "denied by prediction");
    expect(update).not.toHaveBeenCalled();
  });

  it("runs after force-check and low-risk but before prediction-block", () => {
    const ordered = ALL_RULES.map((r) => r.name);
    expect(ordered.indexOf("force-check-required")).toBeLessThan(ordered.indexOf("low-risk-bypass"));
    expect(ordered.indexOf("low-risk-bypass")).toBeLessThan(ordered.indexOf("blacklist"));
    expect(ordered.indexOf("blacklist")).toBeLessThan(ordered.indexOf("prediction-block"));
  });
});
