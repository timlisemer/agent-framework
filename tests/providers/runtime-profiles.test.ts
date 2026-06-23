import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  materializeRuntimeHome,
  sdkToolsForPolicy,
} from "../../src/runtime-home/runtime-profiles.js";
import { buildHookTrustBlock } from "../../adapters/codex/runtime-home.js";
import { activeSpec } from "../../src/adapter/spec.js";
import { TEXT_EDIT_TOOL_NAMES } from "../../src/utils/edit-tools.js";
import { resolveAgentFrameworkRootFromModulePath } from "../../src/utils/paths.js";
import { withEnvForTest } from "../helpers/provider-env.js";

describe("runtime profiles", () => {
  it("resolves adapter dotfolder assets from a compiled dist module path", () => {
    const root = resolveAgentFrameworkRootFromModulePath(
      path.join(process.cwd(), "dist", "src", "utils", "paths.js"),
    );

    expect(root).toBe(process.cwd());
    expect(fs.existsSync(path.join(root, "adapters", "claude", "dotclaude"))).toBe(true);
    expect(fs.existsSync(path.join(root, "adapters", "codex", "dotcodex"))).toBe(true);
  });

  it("refreshes managed Astral Codex homes without deleting session history", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-runtime-profile-"));
    const restore = withEnvForTest({ HOME: home, AGENT_FRAMEWORK_ROOT: undefined });
    try {
      const first = materializeRuntimeHome({ provider: "codex", profile: "managedAstral", runId: "test" });
      expect(first.root).toBe(path.join(home, ".agent-framework", "astral-ai", "codex"));
      const sessionFile = path.join(first.root!, "sessions", "session.jsonl");
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, "{}\n");
      fs.writeFileSync(path.join(first.root!, "config.toml"), "stale config");

      const second = materializeRuntimeHome({ provider: "codex", profile: "managedAstral", runId: "test" });
      expect(fs.existsSync(path.join(second.root!, "hooks.json"))).toBe(true);
      expect(fs.existsSync(sessionFile)).toBe(true);
      expect(fs.readFileSync(path.join(second.root!, "config.toml"), "utf-8")).toContain(`${second.root}/hooks.json:pre_tool_use`);
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refreshes managed Astral Claude homes without deleting project history", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-runtime-profile-claude-"));
    const restore = withEnvForTest({ HOME: home });
    try {
      const first = materializeRuntimeHome({ provider: "claude", profile: "managedAstral", runId: "test" });
      expect(first.root).toBe(path.join(home, ".agent-framework", "astral-ai", "claude"));
      const projectFile = path.join(first.root!, "projects", "-repo", "session.jsonl");
      fs.mkdirSync(path.dirname(projectFile), { recursive: true });
      fs.writeFileSync(projectFile, "{}\n");
      fs.writeFileSync(path.join(first.root!, "settings.json"), "{}\n");

      const second = materializeRuntimeHome({ provider: "claude", profile: "managedAstral", runId: "test" });
      expect(fs.existsSync(projectFile)).toBe(true);
      expect(fs.readFileSync(path.join(second.root!, "settings.json"), "utf-8")).toContain("hooks");
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("materializes internal read-only and write homes without MCP servers plus stop pass-through env", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-runtime-policy-"));
    const restore = withEnvForTest({ HOME: home, AGENT_FRAMEWORK_DISABLE_STOP_BLOCK: "1" });
    try {
      const readOnly = materializeRuntimeHome({ provider: "codex", profile: "internalReadOnly", runId: "ro" });
      expect(readOnly.root).toBe(path.join(home, ".agent-framework", "internal", "read-only", "codex", "ro"));
      expect(readOnly.env.AGENT_FRAMEWORK_SESSION_POLICY).toBe("volatile");
      expect(readOnly.env.AGENT_FRAMEWORK_DISABLE_STOP_BLOCK).toBeUndefined();
      const readOnlyConfig = fs.readFileSync(path.join(readOnly.root!, "config.toml"), "utf-8");
      expect(readOnlyConfig).toContain("sandbox_mode = \"read-only\"");
      expect(readOnlyConfig).not.toContain("[mcp_servers.agent-framework]");
      expect(readOnlyConfig).not.toContain("[plugins.");
      expect(readOnlyConfig).not.toContain("[projects.");
      expect(fs.existsSync(path.join(readOnly.root!, "hooks.json"))).toBe(true);

      const write = materializeRuntimeHome({ provider: "codex", profile: "internalWrite", runId: "wr" });
      expect(write.root).toBe(path.join(home, ".agent-framework", "internal", "write", "codex", "wr"));
      expect(write.env.AGENT_FRAMEWORK_SESSION_POLICY).toBe("write");
      expect(write.env.AGENT_FRAMEWORK_DISABLE_STOP_BLOCK).toBe("1");
      const writeConfig = fs.readFileSync(path.join(write.root!, "config.toml"), "utf-8");
      expect(writeConfig).toContain("sandbox_mode = \"workspace-write\"");
      expect(writeConfig).not.toContain("[mcp_servers.agent-framework]");
      expect(writeConfig).not.toContain("[plugins.");
      expect(writeConfig).not.toContain("[projects.");
      expect(fs.existsSync(path.join(write.root!, "hooks.json"))).toBe(true);
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("sanitizes copied Claude local settings in internal homes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-runtime-claude-local-"));
    const nativeClaude = path.join(home, "native-claude");
    fs.mkdirSync(nativeClaude, { recursive: true });
    fs.writeFileSync(path.join(nativeClaude, "settings.local.json"), JSON.stringify({
      mcpServers: { local: {} },
      hooks: { Stop: [] },
      statusLine: { command: "echo hi" },
      keep: true,
    }));
    const restore = withEnvForTest({ HOME: home, CLAUDE_CONFIG_DIR: nativeClaude });
    try {
      const readOnly = materializeRuntimeHome({ provider: "claude", profile: "internalReadOnly", runId: "claude-local" });
      const localSettings = JSON.parse(
        fs.readFileSync(path.join(readOnly.root!, "settings.local.json"), "utf-8"),
      ) as Record<string, unknown>;
      const settings = JSON.parse(
        fs.readFileSync(path.join(readOnly.root!, "settings.json"), "utf-8"),
      ) as Record<string, unknown>;

      expect(localSettings.keep).toBe(true);
      expect(localSettings.mcpServers).toBeUndefined();
      expect(localSettings.hooks).toBeUndefined();
      expect(localSettings.statusLine).toBeUndefined();
      expect(settings.hooks).toBeDefined();
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps concurrent internal runtime homes isolated by run id", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-runtime-concurrent-"));
    const restore = withEnvForTest({ HOME: home });
    try {
      const first = materializeRuntimeHome({ provider: "codex", profile: "internalReadOnly", runId: "run-a" });
      const marker = path.join(first.root!, "marker.txt");
      fs.writeFileSync(marker, "first");

      const second = materializeRuntimeHome({ provider: "codex", profile: "internalReadOnly", runId: "run-b" });
      expect(second.root).not.toBe(first.root);
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.existsSync(path.join(second.root!, "marker.txt"))).toBe(false);
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("cleans volatile and per-run internal runtime homes without removing write history", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-runtime-cleanup-"));
    const restore = withEnvForTest({ HOME: home });
    try {
      const readOnly = materializeRuntimeHome({ provider: "claude", profile: "internalReadOnly", runId: "ro-clean" });
      expect(fs.existsSync(readOnly.root!)).toBe(true);
      expect(fs.existsSync(readOnly.volatileDir!)).toBe(true);
      readOnly.cleanup();
      expect(fs.existsSync(readOnly.root!)).toBe(false);
      expect(fs.existsSync(readOnly.volatileDir!)).toBe(false);

      const write = materializeRuntimeHome({ provider: "claude", profile: "internalWrite", runId: "wr-clean" });
      const writeHistory = path.join(home, ".agent-framework", "internal", "sessions", "write", "wr-clean");
      expect(fs.existsSync(write.root!)).toBe(true);
      expect(fs.existsSync(writeHistory)).toBe(true);
      write.cleanup();
      expect(fs.existsSync(write.root!)).toBe(false);
      expect(fs.existsSync(writeHistory)).toBe(true);
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns exact tool sets for none, read-only, and write policies", () => {
    expect(sdkToolsForPolicy("none")).toEqual([]);
    expect(sdkToolsForPolicy("read-only")).toEqual(["Read", "Bash"]);
    expect(sdkToolsForPolicy("write")).toEqual(["Read", "Bash", ...TEXT_EDIT_TOOL_NAMES, "Glob", "Grep", "LS", "TodoWrite"]);
    expect(sdkToolsForPolicy("write")).not.toContain(activeSpec().mcpWireName("check"));
  });

  it("builds Codex hook trust keys for the materialized hooks path", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-codex-hook-trust-"));
    try {
      const hooksPath = path.join(home, "hooks.json");
      fs.writeFileSync(hooksPath, JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "true" }] }],
        },
      }));

      const block = buildHookTrustBlock(hooksPath, hooksPath);
      expect(block).toContain(`${hooksPath}:session_start:0:0`);
      expect(block).toContain("trusted_hash = \"sha256:");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps bundled Codex hook trust state in sync with hooks.json", () => {
    const hooksPath = path.join(process.cwd(), "adapters/codex/dotcodex/hooks.json");
    const configPath = path.join(process.cwd(), "adapters/codex/dotcodex/config.toml");
    const generated = buildHookTrustBlock(hooksPath, "/home/tim/.codex/hooks.json");
    const config = fs.readFileSync(configPath, "utf-8");

    expect(config).toContain(generated);
  });
});
