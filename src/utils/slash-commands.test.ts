import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "vitest";
import {
  detectAgentFrameworkWorkflowInvocation,
  extractCodexSkillCommandName,
} from "./slash-commands.js";
import { resolveActiveSlashCommandAllowedTools } from "./transcript.js";

async function writeTranscript(lines: unknown[]): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-framework-slash-"));
  const file = path.join(dir, "transcript.jsonl");
  await fs.promises.writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  return file;
}

function userEntry(content: string): unknown {
  return {
    message: {
      role: "user",
      content,
    },
  };
}

describe("extractCodexSkillCommandName", () => {
  it("maps explicit Codex agent-framework skill mentions to command names", () => {
    expect(extractCodexSkillCommandName("$agent-framework-commit")).toBe("commit");
    expect(extractCodexSkillCommandName("please $agent-framework-quickpush now")).toBe("quickpush");
  });

  it("ignores non-agent-framework skills and unknown command suffixes", () => {
    expect(extractCodexSkillCommandName("$skill-creator")).toBeUndefined();
    expect(extractCodexSkillCommandName("$agent-framework-unknown")).toBeUndefined();
  });
});

describe("detectAgentFrameworkWorkflowInvocation", () => {
  it("detects Claude slash-command tags", () => {
    expect(detectAgentFrameworkWorkflowInvocation("<command-name>/quickpush</command-name>")).toEqual({
      commandName: "quickpush",
      allowedTools: [
        "mcp__agent-framework__push",
        "mcp__agent-framework__commit",
        "mcp__agent_framework__push",
        "mcp__agent_framework__commit",
      ],
    });
    expect(detectAgentFrameworkWorkflowInvocation("<command-name>/plan3</command-name>")?.allowedTools).toEqual([
      "Agent",
      "ExitPlanMode",
    ]);
  });

  it("detects direct slash prompts", () => {
    expect(detectAgentFrameworkWorkflowInvocation("/quickpush")?.commandName).toBe("quickpush");
    expect(detectAgentFrameworkWorkflowInvocation("  /check now")?.allowedTools).toEqual([
      "mcp__agent-framework__check",
      "mcp__agent_framework__check",
    ]);
  });

  it("detects Codex agent-framework skill mentions", () => {
    expect(detectAgentFrameworkWorkflowInvocation("$agent-framework-quickpush")?.commandName).toBe("quickpush");
    expect(detectAgentFrameworkWorkflowInvocation("$agent-framework-transcript")?.allowedTools).toEqual([
      "mcp__agent-framework__transcript",
      "mcp__agent_framework__transcript",
    ]);
  });

  it("ignores unknown and unrelated command-like inputs", () => {
    expect(detectAgentFrameworkWorkflowInvocation("/not-agent-framework")).toBeNull();
    expect(detectAgentFrameworkWorkflowInvocation("$agent-framework-unknown")).toBeNull();
    expect(detectAgentFrameworkWorkflowInvocation("$skill-creator")).toBeNull();
  });
});

describe("resolveActiveSlashCommandAllowedTools", () => {
  it("resolves Claude slash-command tags", async () => {
    const transcript = await writeTranscript([
      userEntry("<command-name>/commit</command-name>"),
    ]);

    await expect(resolveActiveSlashCommandAllowedTools(transcript)).resolves.toEqual([
      "mcp__agent-framework__commit",
      "mcp__agent_framework__commit",
    ]);
  });

  it("resolves explicit Codex agent-framework skill mentions", async () => {
    const transcript = await writeTranscript([
      userEntry("$agent-framework-confirm"),
    ]);

    await expect(resolveActiveSlashCommandAllowedTools(transcript)).resolves.toEqual([
      "mcp__agent-framework__confirm",
      "mcp__agent_framework__confirm",
    ]);
  });

  it("resolves direct slash prompts", async () => {
    const transcript = await writeTranscript([
      userEntry("/check"),
    ]);

    await expect(resolveActiveSlashCommandAllowedTools(transcript)).resolves.toEqual([
      "mcp__agent-framework__check",
      "mcp__agent_framework__check",
    ]);
  });

  it("does not authorize restricted tools for unrelated prompts", async () => {
    const transcript = await writeTranscript([
      userEntry("please commit this when ready"),
    ]);

    await expect(resolveActiveSlashCommandAllowedTools(transcript)).resolves.toBeUndefined();
  });
});
