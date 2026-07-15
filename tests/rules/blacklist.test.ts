import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, vi } from "vitest";
import { blacklistRule } from "../../src/rules/blacklist.js";
import { ALL_RULES } from "../../src/rules/index.js";
import { evaluateRules } from "../../src/rules/evaluator.js";
import { errorAcknowledgeRule } from "../../src/rules/error-acknowledge.js";
import { predictionBlockRule } from "../../src/rules/prediction-block.js";
import { sessionStateDefaults, type SessionState } from "../../src/utils/session-store.js";
import { appendJsonlEntrySync } from "../../src/utils/file-io.js";
import {
  advanceRequiredToolsAfterAllowedTool,
  decidePrediction,
} from "../../src/utils/prediction-types.js";
import type { RuleContext } from "../../src/rules/types.js";
import { makeRuleContext } from "../helpers/rule-context.js";

function stateManagerFor(initial: SessionState): {
  stateManager: RuleContext["stateManager"];
  current: () => SessionState;
} {
  let state = initial;
  return {
    stateManager: {
      update: vi.fn(async (updater: (current: SessionState) => SessionState) => {
        state = updater(state);
        return state;
      }),
    } as unknown as RuleContext["stateManager"],
    current: () => state,
  };
}

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

  it("seeds check as the next predicted tool after a check-routed denial", async () => {
    const initial = sessionStateDefaults();
    const manager = stateManagerFor(initial);
    const ctx = makeCtx({
      toolInput: { command: "npx tsc --noEmit" },
      state: initial,
      stateManager: manager.stateManager,
      latestUserMessage: "verify the change",
    });

    const result = await blacklistRule.check(ctx);
    expect(result).not.toBeNull();
    const fastDeny = (result as { fastDeny: string }).fastDeny;
    expect(fastDeny).toContain("tsc");
    expect(fastDeny).toContain("agent-framework check MCP");

    await blacklistRule.onDenialConfirmed?.(ctx, "tsc denied");
    expect(manager.current().currentPrediction?.explicitlyRequiredTools?.map((item) => item.tool))
      .toEqual(["mcp-check"]);
    expect(manager.current().currentPrediction?.nonBlockingTools?.map((item) => item.tool))
      .toEqual(expect.arrayContaining(["ToolSearch", "ListMcpResources", "ReadMcpResource"]));
    expect(decidePrediction(
      manager.current().currentPrediction,
      "ReadMcpResource",
      { uri: "agent-framework://check" },
      0,
    ).decision).toBe("allow");
    expect(decidePrediction(
      manager.current().currentPrediction,
      "Bash",
      { command: "git status --short" },
      0,
    ).decision).toBe("deny");
  });

  it("consumes the predicted check without pre-seeding a result-dependent wait", async () => {
    const previousAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    const initial = sessionStateDefaults();
    const manager = stateManagerFor(initial);
    const ctx = makeCtx({
      toolInput: { command: "cargo test -p astral-shell workspace_ordering" },
      state: initial,
      stateManager: manager.stateManager,
    });

    try {
      await blacklistRule.onDenialConfirmed?.(ctx, "test command denied");
      const prediction = manager.current().currentPrediction!;
      expect(prediction.explicitlyRequiredTools?.map((item) => item.tool))
        .toEqual(["mcp-check"]);
      const afterCheck = advanceRequiredToolsAfterAllowedTool(
        prediction,
        "mcp-check",
        { working_dir: "/tmp/project" },
      );
      expect(afterCheck.explicitlyRequiredTools?.map((item) => item.tool))
        .toEqual([]);
    } finally {
      if (previousAdapter === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
      else process.env.AGENT_FRAMEWORK_ADAPTER = previousAdapter;
    }
  });

  it("enforces a queued check across the ordered rule pipeline", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blacklist-pipeline-"));
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    const manager = stateManagerFor(sessionStateDefaults());
    const rules = [blacklistRule, predictionBlockRule, errorAcknowledgeRule];
    const pipelineCtx = (toolName: string, toolInput: unknown): RuleContext => makeCtx({
      toolName,
      toolInput,
      projectDir: tempDir,
      transcriptPath,
      sessionDir: tempDir,
      state: manager.current(),
      stateManager: manager.stateManager,
      latestUserMessage: "validate the repository",
    });
    const appendToolLog = (tool: string, status: "allowed" | "denied", reason?: string) => {
      appendJsonlEntrySync(path.join(tempDir, "tool-log.jsonl"), {
        ts: Date.now(),
        toolUseId: `${tool}-${status}`,
        tool,
        status,
        gate: "test",
        reason,
        ms: 1,
      });
    };

    try {
      const deniedCheckCommand = await evaluateRules(
        rules,
        pipelineCtx("Bash", { command: "cargo test" }),
        "PreToolUse",
      );
      expect(deniedCheckCommand).toMatchObject({
        decision: "deny",
        agent: "blacklist",
      });
      appendToolLog("Bash", "denied", deniedCheckCommand?.reason);
      expect(manager.current().currentPrediction?.explicitlyRequiredTools?.map((item) => item.tool))
        .toEqual(["mcp-check"]);

      await expect(evaluateRules(
        rules,
        pipelineCtx("ReadMcpResource", { uri: "agent-framework://check" }),
        "PreToolUse",
      )).resolves.toBeNull();
      await expect(evaluateRules(
        rules,
        pipelineCtx("mcp-check", { working_dir: tempDir }),
        "PreToolUse",
      )).resolves.toBeNull();

      const detour = await evaluateRules(
        rules,
        pipelineCtx("Bash", { command: "git push" }),
        "PreToolUse",
      );
      expect(detour).toMatchObject({
        decision: "deny",
        agent: "prediction-block",
        reason: expect.stringContaining("mcp-check"),
      });

      await manager.stateManager.update((state) => ({
        ...state,
        currentPrediction: state.currentPrediction
          ? advanceRequiredToolsAfterAllowedTool(
              state.currentPrediction,
              "mcp-check",
              { working_dir: tempDir },
            )
          : null,
      }));
      appendToolLog("mcp-check", "allowed");
      await expect(evaluateRules(
        rules,
        pipelineCtx("Read", { file_path: path.join(tempDir, "README.md") }),
        "PreToolUse",
      )).resolves.toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not seed check for a different deterministic Bash denial", async () => {
    const update = vi.fn();
    const ctx = makeCtx({
      toolInput: { command: "git push && npm install express" },
      stateManager: { update } as unknown as RuleContext["stateManager"],
    });

    await blacklistRule.onDenialConfirmed?.(ctx, "git denied");
    expect(update).not.toHaveBeenCalled();
  });

  it("does not seed check for mixed non-read-only commands containing check-routed work", async () => {
    const update = vi.fn();
    const ctx = makeCtx({
      toolInput: { command: "curl https://example.com && npx tsc --noEmit" },
      stateManager: { update } as unknown as RuleContext["stateManager"],
    });

    await blacklistRule.onDenialConfirmed?.(ctx, "check denied");
    expect(update).not.toHaveBeenCalled();
  });

  it("does not seed check for denied nix-eval-jobs", async () => {
    const update = vi.fn();
    const ctx = makeCtx({
      toolInput: { command: "nix-eval-jobs --flake .#checks.x86_64-linux --workers 1" },
      stateManager: { update } as unknown as RuleContext["stateManager"],
    });

    await blacklistRule.onDenialConfirmed?.(ctx, "denied by prediction");
    expect(update).not.toHaveBeenCalled();
  });

  it("runs before prediction-block", () => {
    const ordered = ALL_RULES.map((rule) => rule.name);
    expect(ordered.indexOf("blacklist")).toBeLessThan(ordered.indexOf("prediction-block"));
  });
});
