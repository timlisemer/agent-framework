import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RuleEvaluation } from "../../src/effects/rule-observability.js";
import { describeRules, evaluateRules } from "../../src/rules/index.js";
import { editIntentRule } from "../../src/rules/edit-intent.js";
import type { PreToolRule, RuleContext } from "../../src/rules/types.js";
import { makeRuleContext } from "../helpers/rule-context.js";
import { withTemporaryTestRoot } from "../helpers/temporary-root.js";

const mocks = vi.hoisted(() => ({
  appealHelper: vi.fn(),
}));

vi.mock("../../src/agents/hooks/tool-appeal.js", () => ({
  appealHelper: mocks.appealHelper,
}));

describe("rule observability", () => {
  it("publishes stable serializable descriptors", () => {
    const descriptors = describeRules([
      rule("later", 20, { fastAllow: "ok" }),
      { ...rule("first", 10, null), version: "3", configuration: { threshold: 2 } },
    ]);

    expect(descriptors.map((descriptor) => descriptor.ruleId)).toEqual([
      "agent-framework.rule.first",
      "agent-framework.rule.later",
    ]);
    expect(descriptors[0]).toMatchObject({
      version: "3",
      configuration: { threshold: 2 },
      supportedHookEvents: ["PreToolUse"],
    });
  });

  it("publishes edit-intent as genuinely appealable", () => {
    expect(describeRules([editIntentRule])).toMatchObject([{
      ruleId: "agent-framework.rule.edit-intent",
      appealable: true,
      usesLlm: true,
    }]);
  });

  it.each([
    { overturned: false, expectedDecision: "deny" },
    { overturned: true, expectedDecision: null },
  ])("emits paired stable appeal stages when overturned=$overturned", async ({
    overturned,
    expectedDecision,
  }) => {
    await withTemporaryTestRoot("rule-appeal-observability-", async (temporaryDir) => {
      const transcriptPath = path.join(temporaryDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "", "utf8");
      const stages: Array<{ eventType: string; ruleId: string | null; payload: Record<string, unknown> }> = [];
      const onAppealOverturned = vi.fn().mockResolvedValue(undefined);
      mocks.appealHelper.mockResolvedValueOnce({
        overturned,
        gateNote: overturned ? "explicit user approval" : "denial upheld",
      });
      const appealableRule: PreToolRule = {
        ...rule("appealable", 10, { fastDeny: "policy denied" }),
        appealable: true,
        onAppealOverturned,
      };
      const result = await evaluateRules(
        [appealableRule],
        makeRuleContext({ transcriptPath }),
        "PreToolUse",
        {
          commandId: `appeal-${String(overturned)}`,
          onTrace: () => undefined,
          onStage: (stage) => { stages.push(stage); },
        },
      );

      expect(result?.decision ?? null).toBe(expectedDecision);
      expect(stages).toEqual([
        {
          eventType: "rule.appeal.started",
          ruleId: "agent-framework.rule.appealable",
          payload: {
            ruleId: "agent-framework.rule.appealable",
            reason: "policy denied",
          },
        },
        {
          eventType: "rule.appeal.completed",
          ruleId: "agent-framework.rule.appealable",
          payload: {
            ruleId: "agent-framework.rule.appealable",
            overturned,
            gateNote: overturned ? "explicit user approval" : "denial upheld",
          },
        },
      ]);
      expect(onAppealOverturned).toHaveBeenCalledTimes(overturned ? 1 : 0);
    });
  });

  it("runs edit-intent guidance and overturn state changes through canonical appeal stages", async () => {
    await withTemporaryTestRoot("edit-intent-appeal-observability-", async (temporaryDir) => {
      const transcriptPath = path.join(temporaryDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "", "utf8");
      const base = makeRuleContext();
      let state: RuleContext["state"] = { ...base.state, currentEditIntent: false };
      const stateManager: RuleContext["stateManager"] = {
        async load() { return state; },
        async update(update) { state = update(state); },
      };
      const stages: Array<{ eventType: string }> = [];
      mocks.appealHelper.mockResolvedValue({ overturned: true, gateNote: "explicit edit approval" });
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await expect(evaluateRules(
            [editIntentRule],
            makeRuleContext({
              toolName: "Edit",
              toolInput: { file_path: path.join(temporaryDir, "src", "file.ts") },
              projectDir: temporaryDir,
              sessionDir: path.join(temporaryDir, "session"),
              transcriptPath,
              state,
              stateManager,
            }),
            "PreToolUse",
            {
              commandId: `edit-intent-appeal-${attempt}`,
              onTrace: () => undefined,
              onStage: (stage) => { stages.push(stage); },
            },
          )).resolves.toBeNull();
        }

        expect(mocks.appealHelper.mock.calls.at(-1)?.[7]).toContain("EDIT INTENT WARNING");
        expect(stages.map((stage) => stage.eventType)).toEqual([
          "rule.appeal.started",
          "rule.appeal.completed",
          "rule.appeal.started",
          "rule.appeal.completed",
        ]);
        expect(state).toMatchObject({
          editIntentOverturnCount: 2,
          currentEditIntent: true,
          editIntentTimestamp: expect.any(Number),
        });
      } finally {
        mocks.appealHelper.mockReset();
      }
    });
  });

  it("traces completed and short-circuited rules for one command", async () => {
    const traces: RuleEvaluation[] = [];
    let tick = 0;
    const result = await evaluateRules(
      [
        rule("noop", 10, null),
        rule("allow", 20, { fastAllow: "explicitly safe" }),
        rule("never", 30, { fastDeny: "must not run" }),
      ],
      makeRuleContext({ toolName: "Read" }),
      "PreToolUse",
      {
        commandId: "command-1",
        clock: () => tick++,
        onTrace: (trace) => { traces.push(trace); },
      },
    );

    expect(result).toMatchObject({ decision: "allow", agent: "allow" });
    expect(traces.filter((trace) => trace.status === "started")).toHaveLength(2);
    expect(traces.find((trace) => trace.ruleId.endsWith("noop") && trace.status === "completed"))
      .toMatchObject({ result: "noMatch", elapsedMs: 1 });
    expect(traces.find((trace) => trace.ruleId.endsWith("allow") && trace.status === "completed"))
      .toMatchObject({ result: "fastAllow", reason: "explicitly safe" });
    expect(traces.find((trace) => trace.ruleId.endsWith("never")))
      .toMatchObject({ status: "skipped", reason: "shortCircuited" });
  });

  it("records rule failures before propagating them", async () => {
    const traces: RuleEvaluation[] = [];
    const failing = rule("broken", 10, null);
    failing.check = vi.fn().mockRejectedValue(new Error("broken rule"));

    await expect(evaluateRules(
      [failing],
      makeRuleContext(),
      "PreToolUse",
      { commandId: "command-2", onTrace: (trace) => { traces.push(trace); } },
    )).rejects.toThrow("broken rule");
    expect(traces.at(-1)).toMatchObject({
      ruleId: "agent-framework.rule.broken",
      status: "failed",
      error: "broken rule",
    });
  });
});

function rule(
  name: string,
  priority: number,
  result: Awaited<ReturnType<PreToolRule["check"]>>,
): PreToolRule {
  return {
    name,
    displayName: name,
    priority,
    appealable: false,
    usesLlm: false,
    promptSection: "",
    async check() {
      return result;
    },
  };
}
