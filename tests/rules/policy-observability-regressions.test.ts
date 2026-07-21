import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestScenarioValue } from "../../src/scenario/protocol/digest.js";
import { runAppealWithTrace, type RuleAppealStage } from "../../src/rules/appeal.js";
import { observableBlacklistPolicyDigest } from "../../src/rules/policy-observability.js";
import type { BlacklistPattern } from "../../src/utils/bash-command-policy.js";
import { makeRuleContext } from "../helpers/rule-context.js";
import { withTemporaryTestRoot } from "../helpers/temporary-root.js";

const mocks = vi.hoisted(() => ({
  appealHelper: vi.fn(),
}));

vi.mock("../../src/agents/hooks/tool-appeal.js", () => ({
  appealHelper: mocks.appealHelper,
}));

describe("rule observability regressions", () => {
  afterEach(() => {
    mocks.appealHelper.mockReset();
  });

  it("fingerprints stable matcher identities instead of function source text", () => {
    const firstMatcher = function stableMatcher(command: string): boolean {
      return command.includes("first implementation");
    };
    const secondMatcher = function stableMatcher(command: string): boolean {
      return command.includes("second implementation");
    };
    const renamedMatcher = function renamedMatcher(command: string): boolean {
      return command.includes("first implementation");
    };
    const pattern = (commandMatcher: (command: string) => boolean): BlacklistPattern => ({
      pattern: /dangerous/,
      commandMatcher,
      name: "custom matcher",
      alternative: "Use the safe path",
      topic: "read-only",
    });

    const firstDigest = observableBlacklistPolicyDigest([pattern(firstMatcher)]);
    expect(observableBlacklistPolicyDigest([pattern(secondMatcher)])).toBe(firstDigest);
    expect(observableBlacklistPolicyDigest([pattern(renamedMatcher)])).not.toBe(
      firstDigest,
    );
  });

  it("records the resolved dynamic appeal guidance digest", async () => {
    await withTemporaryTestRoot(
      "resolved-appeal-guidance-",
      async (temporaryDir) => {
        const transcriptPath = path.join(temporaryDir, "transcript.jsonl");
        fs.writeFileSync(transcriptPath, "", "utf8");
        const stages: RuleAppealStage[] = [];
        const resolvedGuidance =
          "The latest user turn explicitly authorizes this exact edit.";
        mocks.appealHelper.mockResolvedValueOnce({
          overturned: false,
          gateNote: "denial upheld",
        });

        await runAppealWithTrace({
          context: makeRuleContext({ transcriptPath, toolName: "Edit" }),
          hookName: "PreToolUse",
          ruleId: "agent-framework.rule.dynamic-guidance",
          reason: "edit intent is missing",
          blockedBy: "dynamic-guidance",
          additionalContext: resolvedGuidance,
          onStage: (stage) => stages.push(stage),
        });

        expect(stages[0]).toMatchObject({
          eventType: "rule.appeal.started",
          payload: {
            guidanceSource: "rule",
            resolvedGuidanceDigest: digestScenarioValue(resolvedGuidance),
          },
        });
        expect(mocks.appealHelper).toHaveBeenCalledTimes(1);
        expect(mocks.appealHelper.mock.calls[0]?.[7]).toBe(resolvedGuidance);
      },
    );
  });
});
