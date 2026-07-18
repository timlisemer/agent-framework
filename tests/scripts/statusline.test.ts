import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatStatusLineEntry,
  renderStatusLine,
} from "../../src/scripts/statusline.js";
import { canonicalRuleStatusLineEntries } from "../../src/scripts/statusline-projection.js";
import type { ScenarioRecord } from "../../src/scenario/protocol/records.js";
import { AGENT_FRAMEWORK_RULE_EXTENSION_ID } from "../../src/effects/rule-observability.js";
import {
  cleanupTemporaryTestRoots,
  createTemporaryTestRoot,
} from "../helpers/temporary-root.js";
import { withEnvironmentForTest } from "../helpers/environment.js";

const roots: string[] = [];
const environmentRestorers: Array<() => void> = [];

afterEach(async () => {
  await cleanupTemporaryTestRoots(roots);
  for (const restore of environmentRestorers.splice(0).reverse()) restore();
});

describe("statusline entrypoint", () => {
  it("renders the folder prefix when the canonical run does not exist", async () => {
    const root = await createTemporaryTestRoot(roots, "statusline-missing-run-");
    const cwd = path.join(root, "fresh-project");
    await fs.mkdir(cwd);
    environmentRestorers.push(withEnvironmentForTest({
      AGENT_FRAMEWORK_SCENARIO_ROOT: path.join(root, "canonical-runs"),
      AGENT_FRAMEWORK_ADAPTER: "codex",
    }));

    await expect(renderStatusLine({
      cwd,
      transcript_path: path.join(root, "not-yet-created.jsonl"),
    })).resolves.toBe("📁 fresh-project");
  });

  it("renders a canonical Agent Framework rule identifier with its configured display name", () => {
    const records: ScenarioRecord[] = [{
      runId: "statusline-run",
      recordSeq: 1,
      recordId: "statusline-record",
      recordedAt: new Date().toISOString(),
      commandId: "statusline-command",
      eventType: "extension.observed",
      visibility: "localSensitive",
      payload: {
        extensionId: AGENT_FRAMEWORK_RULE_EXTENSION_ID,
        event: "rule.evaluation.completed",
        evaluation: {
          evaluationId: "statusline-evaluation",
          ruleId: "agent-framework.rule.sentiment",
          commandId: "statusline-command",
          status: "completed",
          result: "allow",
          elapsedMs: 12,
        },
      },
    }];

    const [entry] = canonicalRuleStatusLineEntries(records);
    expect(entry).toBeDefined();
    expect(formatStatusLineEntry(entry!)).toBe("✓ Sentiment [12ms]");
  });
});
