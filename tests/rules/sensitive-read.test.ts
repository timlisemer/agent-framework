import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { trustedPathRule } from "../../src/rules/trusted-path.js";
import { sessionStateDefaults } from "../../src/utils/session-store.js";
import { makeRuleContext } from "../helpers/rule-context.js";

describe("sensitive Read blocking", () => {
  it("blocks Read access to sensitive paths without adding Read to FILE_TOOLS", async () => {
    const result = await trustedPathRule.check(makeRuleContext({
      toolName: "Read",
      toolInput: { path: ".env.local" },
      toolUseId: "toolu_read_sensitive",
      projectDir: "/repo",
      transcriptPath: "/tmp/transcript.jsonl",
      sessionDir: "/tmp/session",
      sessionId: "session",
      state: sessionStateDefaults(),
    }));

    expect(result).toEqual({
      fastDeny: expect.stringContaining("Sensitive path blocked"),
    });
  });

  it("blocks Read access to provider auth files", async () => {
    const result = await trustedPathRule.check(makeRuleContext({
      toolName: "Read",
      toolInput: { path: "auth.json" },
      toolUseId: "toolu_read_auth",
      projectDir: "/repo",
      transcriptPath: "/tmp/transcript.jsonl",
      sessionDir: "/tmp/session",
      sessionId: "session",
      state: sessionStateDefaults(),
    }));

    expect(result).toEqual({
      fastDeny: expect.stringContaining("Sensitive path blocked"),
    });
  });

  it("routes Codex Read calls through PreToolUse hooks", () => {
    const hooksPath = path.join(process.cwd(), "adapters/codex/dotcodex/hooks.json");
    const hooksConfig = JSON.parse(fs.readFileSync(hooksPath, "utf-8")) as {
      hooks: { PreToolUse: Array<{ matcher?: string }> };
    };
    const matcher = hooksConfig.hooks.PreToolUse[0]?.matcher;

    expect(matcher).toBeDefined();
    expect(new RegExp(`^(?:${matcher})$`).test("Read")).toBe(true);
  });
});
