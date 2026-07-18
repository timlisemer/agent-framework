import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareManagedRuntimeHome, resolveNativeProviderRoot } from "../../src/providers/managed-runtime-home.js";
import { managedProviderRoot } from "../../src/utils/paths.js";
import { withEnvForTest } from "../helpers/provider-env.js";
import { withTemporaryTestRootSync } from "../helpers/temporary-root.js";

describe("managed runtime homes", () => {
  it("uses framework-managed provider roots", () => {
    expect(managedProviderRoot("codex")).toContain(".agent-framework/managed/default/codex");
    expect(managedProviderRoot("claude")).toContain(".agent-framework/managed/default/claude");
  });

  it("does not treat a managed home as the native auth source", () => {
    expect(resolveNativeProviderRoot("codex", { CODEX_HOME: managedProviderRoot("codex") }))
      .not.toBe(managedProviderRoot("codex"));
    expect(resolveNativeProviderRoot("claude", { CLAUDE_CONFIG_DIR: managedProviderRoot("claude") }))
      .not.toBe(managedProviderRoot("claude"));
  });

  it("copies managed credential files into private homes", () => {
    withTemporaryTestRootSync("agent-framework-managed-home-test-", (home) => {
      const nativeCodex = path.join(home, "native-codex");
      fs.mkdirSync(nativeCodex, { recursive: true });
      const sourceAuth = path.join(nativeCodex, "auth.json");
      fs.writeFileSync(sourceAuth, "{}\n", { mode: 0o644 });
      const restoreEnv = withEnvForTest({ HOME: home });
      try {
        const managed = prepareManagedRuntimeHome("codex", { CODEX_HOME: nativeCodex });
        const auth = path.join(managed.root, "auth.json");

        expect(managed.root).toBe(managedProviderRoot("codex"));
        expect(modeOf(managed.root)).toBe(0o700);
        expect(fs.readFileSync(auth, "utf8")).toBe("{}\n");
        expect(modeOf(auth)).toBe(0o600);
      } finally {
        restoreEnv();
      }
    });
  });
});

function modeOf(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}
