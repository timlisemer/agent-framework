import { afterEach, describe, expect, it, vi } from "vitest";

async function loadValidateClaudeMd(stub: string) {
  vi.resetModules();
  process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "claude-md-validate": stub });
  const mod = await import("../../../src/agents/hooks/claude-md-validate.js");
  return mod.validateClaudeMd;
}

describe("validateClaudeMd", () => {
  afterEach(() => {
    delete process.env.AGENT_FRAMEWORK_LLM_STUBS;
    vi.resetModules();
  });

  it("allows an edit that removes a command code-block violation", async () => {
    const validateClaudeMd = await loadValidateClaudeMd("OK");
    const current = [
      "# CLAUDE.md",
      "",
      "## Testing MCP Server",
      "",
      "```bash",
      "make build",
      "```",
      "",
      "Only do this when explicitly mentioned by the user.",
      "",
    ].join("\n");
    const replacement = [
      "## Testing MCP Server",
      "",
      "Use the agent-framework check MCP for repository verification.",
      "",
    ].join("\n");

    const result = await validateClaudeMd(
      current,
      "Edit",
      {
        old_string: current.slice(current.indexOf("## Testing MCP Server")),
        new_string: replacement,
      },
      process.cwd(),
      "PreToolUse",
    );

    expect(result).toEqual({ approved: true });
  });

  it("denies an edit whose resulting file still contains a command code-block violation", async () => {
    const validateClaudeMd = await loadValidateClaudeMd("OK");
    const current = "# CLAUDE.md\n";
    const next = [
      "# CLAUDE.md",
      "",
      "## Testing MCP Server",
      "",
      "```bash",
      "make build",
      "```",
      "",
    ].join("\n");

    const result = await validateClaudeMd(
      current,
      "Write",
      { content: next },
      process.cwd(),
      "PreToolUse",
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("make build");
  });
});
