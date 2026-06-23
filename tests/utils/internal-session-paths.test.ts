import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentFrameworkSessionDir } from "../../src/utils/paths.js";
import { withEnvForTest } from "../helpers/provider-env.js";

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

describe("internal session path routing", () => {
  it("routes volatile internal sessions outside the user sessions root", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-internal-paths-"));
    restores.push(() => fs.rmSync(home, { recursive: true, force: true }));
    restores.push(withEnvForTest({
      HOME: home,
      AGENT_FRAMEWORK_SESSION_POLICY: "volatile",
      AGENT_FRAMEWORK_RUN_ID: "volatile-run",
      AGENT_FRAMEWORK_VOLATILE_DIR: path.join(home, ".agent-framework", "internal", "volatile", "volatile-run"),
    }));

    const dir = getAgentFrameworkSessionDir({ transcriptPath: path.join(home, "transcript.jsonl") });
    expect(dir).toContain(".agent-framework/internal/volatile/volatile-run");
    expect(dir).not.toContain(".agent-framework/sessions");
  });

  it("routes write internal sessions under the internal write namespace", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-internal-write-"));
    restores.push(() => fs.rmSync(home, { recursive: true, force: true }));
    restores.push(withEnvForTest({
      HOME: home,
      AGENT_FRAMEWORK_SESSION_POLICY: "write",
      AGENT_FRAMEWORK_RUN_ID: "write-run",
    }));

    const dir = getAgentFrameworkSessionDir({ transcriptPath: path.join(home, "transcript.jsonl") });
    expect(dir).toBe(path.join(home, ".agent-framework", "internal", "sessions", "write", "write-run"));
  });
});
