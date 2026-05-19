import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { SLASH_COMMAND_ALLOWED_TOOLS, RESTRICTED_MCPS } from "./slash-commands.js";
import { resolveActiveSlashCommandAllowedTools } from "./transcript.js";
import { claudeSpec } from "../../adapters/claude/index.js";
import { codexSpec } from "../../adapters/codex/index.js";

async function writeTranscript(lines: unknown[]): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-framework-slash-"));
  const file = path.join(dir, "transcript.jsonl");
  await fs.promises.writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  return file;
}

function claudeUserEntry(content: string): unknown {
  return {
    message: {
      role: "user",
      content,
    },
  };
}

describe("SLASH_COMMAND_ALLOWED_TOOLS canonical keys", () => {
  it("commit maps to canonical mcp-commit tool", () => {
    expect(SLASH_COMMAND_ALLOWED_TOOLS["commit"]).toEqual(["mcp-commit"]);
  });

  it("push maps to canonical mcp-push and mcp-commit tools", () => {
    expect(SLASH_COMMAND_ALLOWED_TOOLS["push"]).toEqual(["mcp-push", "mcp-commit"]);
  });

  it("quickpush maps to canonical mcp-push and mcp-commit tools", () => {
    expect(SLASH_COMMAND_ALLOWED_TOOLS["quickpush"]).toEqual(["mcp-push", "mcp-commit"]);
  });

  it("check maps to canonical mcp-check tool", () => {
    expect(SLASH_COMMAND_ALLOWED_TOOLS["check"]).toEqual(["mcp-check"]);
  });

  it("locate-scenario maps to canonical mcp-locate_scenario tool", () => {
    expect(SLASH_COMMAND_ALLOWED_TOOLS["locate-scenario"]).toEqual(["mcp-locate_scenario"]);
  });

  it("plan3 maps to plan workflow tools", () => {
    expect(SLASH_COMMAND_ALLOWED_TOOLS["plan3"]).toEqual([
      "Agent",
      "ExitPlanMode",
      "mcp-create_planfile",
      "mcp-validate_plan",
    ]);
  });
});

describe("RESTRICTED_MCPS", () => {
  it("contains commit, push, confirm", () => {
    expect(RESTRICTED_MCPS.has("commit")).toBe(true);
    expect(RESTRICTED_MCPS.has("push")).toBe(true);
    expect(RESTRICTED_MCPS.has("confirm")).toBe(true);
    expect(RESTRICTED_MCPS.has("create_planfile")).toBe(false);
    expect(RESTRICTED_MCPS.has("check")).toBe(false);
  });
});

describe("claudeSpec.recognizeWorkflowInvocation", () => {
  it("detects Claude slash-command tags", () => {
    expect(claudeSpec.recognizeWorkflowInvocation("<command-name>/quickpush</command-name>")).toBe("quickpush");
    expect(claudeSpec.recognizeWorkflowInvocation("<command-name>/plan3</command-name>")).toBe("plan3");
  });

  it("detects direct slash prompts", () => {
    expect(claudeSpec.recognizeWorkflowInvocation("/quickpush")).toBe("quickpush");
    expect(claudeSpec.recognizeWorkflowInvocation("  /check now")).toBe("check");
    expect(claudeSpec.recognizeWorkflowInvocation("  /locate-scenario \"quote\"")).toBe("locate-scenario");
  });

  it("ignores unknown commands", () => {
    expect(claudeSpec.recognizeWorkflowInvocation("/not-agent-framework")).toBeNull();
    expect(claudeSpec.recognizeWorkflowInvocation("$agent-framework-commit")).toBeNull();
  });
});

describe("claudeSpec.isWorkflowInvocationOnly", () => {
  it("treats bare commands and plain command parameters as workflow-only", () => {
    expect(claudeSpec.isWorkflowInvocationOnly("<command-name>/quickpush</command-name>")).toBe(true);
    expect(claudeSpec.isWorkflowInvocationOnly("/quickpush")).toBe(true);
    expect(claudeSpec.isWorkflowInvocationOnly("/check now")).toBe(true);
    expect(claudeSpec.isWorkflowInvocationOnly('/locate-scenario "quote"')).toBe(true);
  });

  it("does not treat mixed human instructions as workflow-only", () => {
    expect(claudeSpec.isWorkflowInvocationOnly("<command-name>/plan3</command-name>\nthats complete bullshit do not cheat")).toBe(false);
    expect(claudeSpec.isWorkflowInvocationOnly("/quickpush and then fix complaints by editing files")).toBe(false);
  });
});

describe("codexSpec.recognizeWorkflowInvocation", () => {
  it("detects Codex skill mentions", () => {
    expect(codexSpec.recognizeWorkflowInvocation("$agent-framework-quickpush")).toBe("quickpush");
    expect(codexSpec.recognizeWorkflowInvocation("$agent-framework-transcript")).toBe("transcript");
    expect(codexSpec.recognizeWorkflowInvocation("$agent-framework-locate-scenario")).toBe("locate-scenario");
  });

  it("detects Codex skill context blocks", () => {
    expect(codexSpec.recognizeWorkflowInvocation("<skill>\n<name>agent-framework-quickpush</name>\n</skill>")).toBe("quickpush");
    expect(codexSpec.recognizeWorkflowInvocation("---\nname: agent-framework-confirm\ndescription: Confirm\n---")).toBe("confirm");
  });

  it("ignores non-agent-framework and unknown command suffixes", () => {
    expect(codexSpec.recognizeWorkflowInvocation("$skill-creator")).toBeNull();
    expect(codexSpec.recognizeWorkflowInvocation("$agent-framework-unknown")).toBeNull();
    expect(codexSpec.recognizeWorkflowInvocation("<skill><name>agent-framework-unknown</name></skill>")).toBeNull();
  });
});

describe("codexSpec.isWorkflowInvocationOnly", () => {
  it("treats bare Codex skill wrappers as workflow-only", () => {
    expect(codexSpec.isWorkflowInvocationOnly("$agent-framework-quickpush")).toBe(true);
    expect(codexSpec.isWorkflowInvocationOnly("<skill>\n<name>agent-framework-quickpush</name>\n</skill>")).toBe(true);
    expect(codexSpec.isWorkflowInvocationOnly("---\nname: agent-framework-confirm\ndescription: Confirm\n---")).toBe(true);
  });

  it("does not treat inline mentions or pasted metadata as workflow-only", () => {
    expect(codexSpec.isWorkflowInvocationOnly("please call $agent-framework-quickpush and fix complaints by editing files")).toBe(false);
    expect(codexSpec.isWorkflowInvocationOnly("quoted:\n<skill>\n<name>agent-framework-quickpush</name>\n</skill>")).toBe(false);
  });
});

describe("resolveActiveSlashCommandAllowedTools (Claude adapter)", () => {
  it("resolves Claude slash-command tags to canonical tool names", async () => {
    const transcript = await writeTranscript([
      claudeUserEntry("<command-name>/commit</command-name>"),
    ]);

    await expect(resolveActiveSlashCommandAllowedTools(transcript)).resolves.toEqual(["mcp-commit"]);
  });

  it("resolves check command to canonical mcp-check", async () => {
    const transcript = await writeTranscript([
      claudeUserEntry("/check"),
    ]);

    await expect(resolveActiveSlashCommandAllowedTools(transcript)).resolves.toEqual(["mcp-check"]);
  });

  it("resolves locate-scenario command to canonical mcp-locate_scenario", async () => {
    const transcript = await writeTranscript([
      claudeUserEntry("/locate-scenario"),
    ]);

    await expect(resolveActiveSlashCommandAllowedTools(transcript)).resolves.toEqual(["mcp-locate_scenario"]);
  });

  it("resolves quickpush to canonical mcp-push and mcp-commit", async () => {
    const transcript = await writeTranscript([
      claudeUserEntry("<command-name>/quickpush</command-name>"),
    ]);

    await expect(resolveActiveSlashCommandAllowedTools(transcript)).resolves.toEqual([
      "mcp-push",
      "mcp-commit",
    ]);
  });

  it("does not authorize tools for unrelated prompts", async () => {
    const transcript = await writeTranscript([
      claudeUserEntry("please commit this when ready"),
    ]);

    await expect(resolveActiveSlashCommandAllowedTools(transcript)).resolves.toBeUndefined();
  });
});
