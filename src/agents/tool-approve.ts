import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import { getModelId } from "../types.js";

const anthropic = new Anthropic();

export async function approveCommand(
  command: string,
  projectDir: string
): Promise<{ approved: boolean; reason?: string }> {

  // Load CLAUDE.md if exists
  let rules = "";
  const claudeMdPath = path.join(projectDir, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    rules = fs.readFileSync(claudeMdPath, "utf-8");
  }

  const response = await anthropic.messages.create({
    model: getModelId("haiku"),
    max_tokens: 150,
    messages: [{
      role: "user",
      content: `You are a command approval gate. Your job is to approve or deny bash commands.

PROJECT RULES (from CLAUDE.md):
${rules || "No project-specific rules."}

COMMAND TO EVALUATE:
${command}

DENY if:
- Command violates any rule in CLAUDE.md
- Command is destructive (rm -rf, drop database, etc.)
- Command uses "cd &&" pattern (suggest --manifest-path or similar)
- Command runs a tool when CLAUDE.md specifies a different one (e.g., "cargo check" when only "make check" is allowed)
- Command could leak secrets or credentials
- Command modifies system files outside project

APPROVE if:
- Command follows CLAUDE.md rules
- Command is safe and reasonable

Reply with EXACTLY one line:
APPROVE
or
DENY: <specific reason and suggested alternative if applicable>`
    }]
  });

  const decision = (response.content[0] as { type: "text"; text: string }).text.trim();

  if (decision.startsWith("DENY")) {
    return {
      approved: false,
      reason: decision.replace("DENY: ", "")
    };
  }

  return { approved: true };
}
