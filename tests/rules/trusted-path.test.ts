import { describe, expect, it } from "vitest";
import { trustedPathRule } from "../../src/rules/trusted-path.js";
import { isSensitivePath } from "../../src/rules/utils.js";
import { sessionStateDefaults } from "../../src/utils/session-store.js";
import { makeRuleContext } from "../helpers/rule-context.js";

function makeCtx(overrides: Parameters<typeof makeRuleContext>[0] = {}) {
  return makeRuleContext({
    toolName: "Edit",
    toolInput: { file_path: "src/main.ts" },
    toolUseId: "toolu_sensitive",
    projectDir: "/repo",
    transcriptPath: "/tmp/transcript.jsonl",
    sessionDir: "/tmp/session",
    sessionId: "session",
    state: sessionStateDefaults(),
    ...overrides,
  });
}

describe("sensitive path classification", () => {
  it("does not classify documented provider configuration template as sensitive", () => {
    expect(isSensitivePath("docs/provider-configuration.md")).toBe(false);
    expect(isSensitivePath("/repo/docs/provider-configuration.md")).toBe(false);
  });

  it("does not classify benign names containing sensitive words as sensitive", () => {
    for (const filePath of [
      "src/secretary.ts",
      "docs/passwordless.md",
      "mycredentials.txt",
      "secretsauce/config.json",
    ]) {
      expect(isSensitivePath(filePath), filePath).toBe(false);
    }
  });

  it("classifies real env, credential, SOPS, age, and private key paths as sensitive", () => {
    for (const filePath of [
      ".env",
      ".env.local",
      "secrets.sops.yaml",
      ".sops.yaml",
      "keys.txt.agekey",
      "id_ed25519",
      "/repo/.ssh/config",
      "/repo/.aws/credentials",
      "/repo/.kube/config",
      "secrets/config.json",
      "credentials/api.yaml",
      "passwords/token.txt",
      "secrets-backup/config.json",
      "prodpasswords.json",
      "prod-passwords.json",
    ]) {
      expect(isSensitivePath(filePath), filePath).toBe(true);
    }
  });
});

describe("trustedPathRule", () => {
  it("allows editing documented provider configuration template", async () => {
    const result = await trustedPathRule.check(makeCtx({
      toolInput: { file_path: "docs/provider-configuration.md" },
    }));
    expect(result).toBeNull();
  });

  it("blocks editing real sensitive files", async () => {
    const result = await trustedPathRule.check(makeCtx({
      toolInput: { file_path: ".env.local" },
    }));
    expect(result).toEqual({
      fastDeny: expect.stringContaining("Sensitive path blocked"),
    });
  });

  it("blocks editing files under sensitive directory names", async () => {
    for (const filePath of ["secrets/config.json", "credentials/api.yaml", "passwords/token.txt"]) {
      const result = await trustedPathRule.check(makeCtx({
        toolInput: { file_path: filePath },
      }));
      expect(result, filePath).toEqual({
        fastDeny: expect.stringContaining("Sensitive path blocked"),
      });
    }
  });

  it("blocks canonical multi-file patch deletion when any target is sensitive", async () => {
    const result = await trustedPathRule.check(makeCtx({
      toolInput: {
        file_path: "src/main.ts",
        file_paths: ["src/main.ts", ".env.local"],
      },
    }));
    expect(result).toEqual({
      fastDeny: expect.stringContaining(".env.local"),
    });
  });
});
