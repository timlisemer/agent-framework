import { describe, expect, it } from "vitest";
import * as claudeMcp from "../../adapters/claude/recognize-mcp.js";
import * as codexMcp from "../../adapters/codex/recognize-mcp.js";

describe("adapter MCP recognition", () => {
  it("recognizes Claude validate_plan wire name", () => {
    expect(claudeMcp.recognizeMcp("mcp__agent-framework__validate_plan")).toBe("validate_plan");
    expect(claudeMcp.mcpWireName("validate_plan")).toBe("mcp__agent-framework__validate_plan");
    expect(claudeMcp.recognizeMcp("mcp__agent-framework__create_planfile")).toBe("create_planfile");
    expect(claudeMcp.mcpWireName("create_planfile")).toBe("mcp__agent-framework__create_planfile");
    expect(claudeMcp.recognizeMcp("mcp__agent-framework__locate_scenario")).toBe("locate_scenario");
    expect(claudeMcp.mcpWireName("locate_scenario")).toBe("mcp__agent-framework__locate_scenario");
  });

  it("recognizes Codex validate_plan wire name", () => {
    expect(codexMcp.recognizeMcp("mcp__agent_framework__validate_plan")).toBe("validate_plan");
    expect(codexMcp.mcpWireName("validate_plan")).toBe("mcp__agent_framework__validate_plan");
    expect(codexMcp.recognizeMcp("mcp__agent_framework__create_planfile")).toBe("create_planfile");
    expect(codexMcp.mcpWireName("create_planfile")).toBe("mcp__agent_framework__create_planfile");
    expect(codexMcp.recognizeMcp("mcp__agent_framework__locate_scenario")).toBe("locate_scenario");
    expect(codexMcp.mcpWireName("locate_scenario")).toBe("mcp__agent_framework__locate_scenario");
  });
});
