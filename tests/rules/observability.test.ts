import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RuleEvaluation } from "../../src/effects/rule-observability.js";
import {
  ALL_RULES,
  describeRules,
  evaluateRules,
} from "../../src/rules/index.js";
import { editIntentRule } from "../../src/rules/edit-intent.js";
import { driftDetectRule } from "../../src/rules/drift-detect.js";
import { questionValidateRule } from "../../src/rules/question-validate.js";
import type { PreToolRule, RuleContext } from "../../src/rules/types.js";
import { makeRuleContext } from "../helpers/rule-context.js";
import { withTemporaryTestRoot } from "../helpers/temporary-root.js";
import {
  BLACKLIST_RULE_POLICY,
  DRIFT_RULE_POLICY,
  SENSITIVE_PATH_RULE_POLICY,
  TOOL_APPROVE_RULE_POLICY,
  nextDriftEscalationLevel,
} from "../../src/rules/policies.js";
import {
  observableAgentConfiguration,
  observableBlacklistPolicyDigest,
  observableSensitivePathPolicyDigest,
  observableTranscriptWindow,
} from "../../src/rules/policy-observability.js";
import {
  RESTRICTED_MCPS,
  SLASH_COMMAND_WORKFLOWS,
} from "../../src/utils/slash-commands.js";
import { buildQuestionValidateAgent } from "../../src/utils/agent-configs.js";
import {
  APPEAL_COUNTS,
  QUESTION_VALIDATE_COUNTS,
  VALIDATE_INTENT_COUNTS,
} from "../../src/utils/transcript-presets.js";

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
      {
        ...rule("first", 10, null),
        version: "3",
        configuration: { threshold: 2 },
      },
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

  it("publishes versioned effective configuration for every registered rule", () => {
    const descriptors = describeRules(ALL_RULES);

    expect(descriptors).toHaveLength(ALL_RULES.length);
    for (const [index, descriptor] of descriptors.entries()) {
      const rule = [...ALL_RULES].sort(
        (left, right) => left.priority - right.priority,
      )[index]!;
      expect(rule.version, descriptor.ruleId).toBe("1");
      expect(rule.configuration, descriptor.ruleId).toMatchObject({
        policy: expect.any(String),
      });
      expect(descriptor.version, descriptor.ruleId).not.toBe("");
      expect(
        Object.keys(descriptor.configuration),
        descriptor.ruleId,
      ).not.toHaveLength(0);
      expect(descriptor.configuration.policy, descriptor.ruleId).toEqual(
        expect.any(String),
      );
      if (descriptor.usesLlm) {
        const evaluationAgents = descriptor.configuration.evaluationAgents;
        const agents =
          evaluationAgents &&
          typeof evaluationAgents === "object" &&
          !Array.isArray(evaluationAgents)
            ? Object.values(evaluationAgents)
            : [descriptor.configuration.evaluationAgent];
        expect(agents.length, descriptor.ruleId).toBeGreaterThan(0);
        for (const agent of agents) {
          expect(agent, descriptor.ruleId).toMatchObject({
          name: expect.any(String),
          modelTier: expect.stringMatching(/^(haiku|sonnet|opus)$/),
          policyDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        });
      }
    }
    }
  });

  it("projects each registered LLM rule's exact execution agent", () => {
    const descriptors = new Map(
      describeRules(ALL_RULES).map((descriptor) => [
        descriptor.ruleId,
        descriptor,
      ]),
    );
    for (const rule of ALL_RULES.filter((candidate) => candidate.usesLlm)) {
      const descriptor = descriptors.get(`agent-framework.rule.${rule.name}`)!;
      if (rule.evaluationAgent) {
        expect(descriptor.configuration.evaluationAgent, rule.name).toEqual(
          observableAgentConfiguration(rule.evaluationAgent),
        );
      } else {
        expect(
          descriptor.configuration.evaluationAgents,
          rule.name,
        ).toBeDefined();
      }
    }
  });

  it("publishes the runtime-derived question-validation agent policy", () => {
    expect(questionValidateRule.evaluationAgent).toEqual(
      buildQuestionValidateAgent(),
    );
    expect(describeRules([questionValidateRule])[0]?.configuration)
      .toMatchObject({
        evaluationAgent: observableAgentConfiguration(
          buildQuestionValidateAgent(),
        ),
      });
  });

  it("projects descriptor configuration from the same policy object consumed by the rule", async () => {
    const policy = { blockedValue: true };
    const policyRule: PreToolRule = {
      ...rule("local-policy", 10, null),
      configuration: policy,
      async check(ctx) {
        const runInBackground =
          typeof ctx.toolInput === "object" && ctx.toolInput !== null
            ? Reflect.get(ctx.toolInput, "run_in_background")
            : undefined;
        return runInBackground === policy.blockedValue
          ? { fastDeny: "policy denied" }
          : null;
      },
    };
    expect(describeRules([policyRule])[0]?.configuration.blockedValue).toBe(
      true,
    );
    policy.blockedValue = false;
    expect(describeRules([policyRule])[0]?.configuration.blockedValue).toBe(
      false,
    );
    await expect(
      policyRule.check(
        makeRuleContext({
        toolName: "Agent",
        toolInput: { run_in_background: true },
        }),
      ),
    ).resolves.toBeNull();
  });

  it("publishes material tool and path policy values through production descriptors", () => {
    const descriptors = new Map(
      describeRules(ALL_RULES).map((descriptor) => [
        descriptor.ruleId,
        descriptor.configuration,
      ]),
    );

    expect(descriptors.get("agent-framework.rule.tool-approve")).toMatchObject({
      restrictedMcps: [...RESTRICTED_MCPS].sort(),
      slashCommandWorkflows: SLASH_COMMAND_WORKFLOWS,
    });
    expect(TOOL_APPROVE_RULE_POLICY.restrictedMcps).toEqual(
      [...RESTRICTED_MCPS].sort(),
    );
    expect(
      descriptors.get("agent-framework.rule.blacklist")
        ?.hardBlacklistPolicyDigest,
    ).toBe(observableBlacklistPolicyDigest());
    expect(BLACKLIST_RULE_POLICY.hardBlacklistPolicyDigest).toBe(
      observableBlacklistPolicyDigest(),
    );
    expect(
      descriptors.get("agent-framework.rule.sensitive-path-block")
        ?.classificationPolicyDigest,
    ).toBe(observableSensitivePathPolicyDigest());
    expect(SENSITIVE_PATH_RULE_POLICY.classificationPolicyDigest).toBe(
      observableSensitivePathPolicyDigest(),
    );
  });

  it("derives production drift transitions from the published escalation levels", () => {
    expect(driftDetectRule.configuration).toBe(DRIFT_RULE_POLICY);
    expect(
      DRIFT_RULE_POLICY.escalationLevels.map(nextDriftEscalationLevel),
    ).toEqual([1, 2, 2]);
    expect(
      describeRules([driftDetectRule])[0]?.configuration.escalationLevels,
    ).toEqual([0, 1, 2]);
  });

  it("serializes every unbounded production transcript window explicitly", () => {
    expect(observableTranscriptWindow(QUESTION_VALIDATE_COUNTS)).toMatchObject({
      counts: { user: { count: "all" }, assistant: { count: 20 } },
    });
    expect(observableTranscriptWindow(VALIDATE_INTENT_COUNTS)).toMatchObject({
      counts: { user: { count: "all" }, assistant: { count: 5 } },
    });
    expect(observableTranscriptWindow(APPEAL_COUNTS)).toMatchObject({
      counts: { user: { count: "all" }, assistant: { count: 10 } },
    });
    const descriptors = new Map(
      describeRules(ALL_RULES).map((descriptor) => [
        descriptor.ruleId,
        descriptor,
      ]),
    );
    expect(
      descriptors.get("agent-framework.rule.question-validate")?.configuration
        .transcriptWindow,
    ).toEqual(observableTranscriptWindow(QUESTION_VALIDATE_COUNTS));
    expect(
      descriptors.get("agent-framework.rule.validate-intent")?.configuration
        .transcriptWindow,
    ).toEqual(observableTranscriptWindow(VALIDATE_INTENT_COUNTS));
    expect(
      descriptors.get("agent-framework.rule.edit-intent")?.configuration
        .appealTranscriptWindow,
    ).toEqual(observableTranscriptWindow(APPEAL_COUNTS));
  });

  it("publishes edit-intent as genuinely appealable", () => {
    expect(describeRules([editIntentRule])).toMatchObject([
      {
      ruleId: "agent-framework.rule.edit-intent",
      appealable: true,
      usesLlm: true,
      },
    ]);
  });

  it.each([
    { overturned: false, expectedDecision: "deny" },
    { overturned: true, expectedDecision: null },
  ])(
    "emits paired stable appeal stages when overturned=$overturned",
    async ({ overturned, expectedDecision }) => {
      await withTemporaryTestRoot(
        "rule-appeal-observability-",
        async (temporaryDir) => {
      const transcriptPath = path.join(temporaryDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "", "utf8");
          const stages: Array<{
            eventType: string;
            ruleId: string | null;
            payload: Record<string, unknown>;
          }> = [];
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
              onStage: (stage) => {
                stages.push(stage);
              },
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
                gateNote: overturned
                  ? "explicit user approval"
                  : "denial upheld",
          },
        },
      ]);
      expect(onAppealOverturned).toHaveBeenCalledTimes(overturned ? 1 : 0);
        },
      );
    },
  );

  it("runs edit-intent guidance and overturn state changes through canonical appeal stages", async () => {
    await withTemporaryTestRoot(
      "edit-intent-appeal-observability-",
      async (temporaryDir) => {
      const transcriptPath = path.join(temporaryDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "", "utf8");
      const base = makeRuleContext();
        let state: RuleContext["state"] = {
          ...base.state,
          currentEditIntent: false,
        };
      const stateManager: RuleContext["stateManager"] = {
          async load() {
            return state;
          },
          async update(update) {
            state = update(state);
          },
      };
      const stages: Array<{ eventType: string }> = [];
        mocks.appealHelper.mockResolvedValue({
          overturned: true,
          gateNote: "explicit edit approval",
        });
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            await expect(
              evaluateRules(
            [editIntentRule],
            makeRuleContext({
              toolName: "Edit",
                  toolInput: {
                    file_path: path.join(temporaryDir, "src", "file.ts"),
                  },
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
                  onStage: (stage) => {
                    stages.push(stage);
            },
                },
              ),
            ).resolves.toBeNull();
        }

          expect(mocks.appealHelper.mock.calls.at(-1)?.[7]).toContain(
            "EDIT INTENT WARNING",
          );
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
      },
    );
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
        onTrace: (trace) => {
          traces.push(trace);
        },
      },
    );

    expect(result).toMatchObject({ decision: "allow", agent: "allow" });
    expect(traces.filter((trace) => trace.status === "started")).toHaveLength(
      2,
    );
    expect(
      traces.find(
        (trace) =>
          trace.ruleId.endsWith("noop") && trace.status === "completed",
      ),
    ).toMatchObject({ result: "noMatch", elapsedMs: 1 });
    expect(
      traces.find(
        (trace) =>
          trace.ruleId.endsWith("allow") && trace.status === "completed",
      ),
    ).toMatchObject({ result: "fastAllow", reason: "explicitly safe" });
    expect(
      traces.find((trace) => trace.ruleId.endsWith("never")),
    ).toMatchObject({ status: "skipped", reason: "shortCircuited" });
  });

  it("records rule failures before propagating them", async () => {
    const traces: RuleEvaluation[] = [];
    const failing = rule("broken", 10, null);
    failing.check = vi.fn().mockRejectedValue(new Error("broken rule"));

    await expect(
      evaluateRules([failing], makeRuleContext(), "PreToolUse", {
        commandId: "command-2",
        onTrace: (trace) => {
          traces.push(trace);
        },
      }),
    ).rejects.toThrow("broken rule");
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
