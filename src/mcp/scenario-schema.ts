import { z } from "zod";

export const predictionAnnotationSchema = z.object({
  verdict: z.enum(["correct", "too_broad", "wrong", "INVESTIGATE"]).describe("Hindsight verdict on the prediction that caused this deny."),
  forbidden_blocks: z.array(z.object({
    tool: z.string().optional(),
    target_pattern: z.string().optional(),
  })).optional().describe("Required when verdict='too_broad'. LITERAL tool names (no regex metachars) the prediction MUST NOT match after narrowing."),
  intent_must_contain: z.string().optional().describe("Substring that must appear in the live prediction's intent. Auto-populated with first 60 chars."),
  expected_mood: z.enum(["angry", "frustrated", "neutral", "satisfied", "happy"]).optional().describe("Assert the live prediction's mood field equals this value."),
  expected_trust: z.enum(["low", "normal", "high"]).optional().describe("Assert the live prediction's trust field equals this value."),
  notes: z.string().optional(),
});

export const reasonMustSchema = z.object({
  contains: z.array(z.string().min(1)).min(1).optional(),
  not_contains: z.array(z.string().min(1)).min(1).optional(),
  matches: z.array(z.string().min(1)).min(1).optional(),
  not_matches: z.array(z.string().min(1)).min(1).optional(),
}).optional();

export const richExpectationSchema = z.object({
  expected: z.string().describe("The decision the hook must produce: allow/deny/pass/block (or INVESTIGATE placeholder)."),
  by: z.string().optional().describe("Rule/gate name the denial must come from (matches tool-log gate field)."),
  at: z.union([z.number(), z.literal("full")]).optional().describe("1-based line cap this expectation scores under. Omit or 'full' for the default post-flush run."),
  notes: z.string().optional().describe("Free-text explanation of why this expectation exists."),
  prediction: predictionAnnotationSchema.optional().describe("Set ONLY when expected='deny' AND by is one of {prediction-block, batch-sibling}."),
  reason_must: reasonMustSchema.describe("Reason-text assertion clauses. Only valid when expected is one of {deny, block}."),
});

const scenarioBlockSchema = z.record(z.string(), z.unknown());

export const scenarioSchema = z.object({
  schema_version: z.union([z.literal(1), z.literal(2)]).describe("Scenario schema version. Must be 1 or 2."),
  name: z.string().describe("Slug for the scenario. Must match [A-Za-z0-9._-]+."),
  description: z.string().optional(),
  transcript: z.array(z.union([
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.union([z.string(), z.array(scenarioBlockSchema)]),
      uuid: z.string().optional(),
      parentUuid: z.string().nullable().optional(),
      isMeta: z.boolean().optional(),
    }),
    z.object({
      role: z.literal("assistant_split"),
      msg_id: z.string(),
      lines: z.array(z.object({
        blocks: z.array(scenarioBlockSchema),
      })).min(1),
    }),
  ])).min(1),
  target: z.object({
    hook: z.enum(["PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit", "SessionStart"]),
    tool_use_ref: z.union([z.string(), z.literal("last")]).optional(),
    prompt_override: z.string().optional(),
    batch_visible_through: z.number().int().nonnegative().optional(),
    fanout: z.boolean().optional(),
  }),
  env: z.object({
    permission_mode: z.enum(["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"]).optional(),
    subagent: z.boolean().optional(),
    cwd: z.string().optional(),
    timeout_ms: z.number().optional(),
    llm_stubs: z.record(z.string().min(1), z.string().min(1)).optional(),
  }).optional(),
  expect: z.union([
    z.object({
      expected: z.string(),
      by: z.string().optional(),
      notes: z.string().optional(),
      prediction: predictionAnnotationSchema.optional(),
      reason_must: reasonMustSchema,
    }),
    z.array(z.object({
      position: z.number().int().nonnegative(),
      expected: z.string(),
      by: z.string().optional(),
      notes: z.string().optional(),
      prediction: predictionAnnotationSchema.optional(),
      reason_must: reasonMustSchema,
    })).min(1),
  ]),
  predictions: z.object({
    must_block: z.array(z.object({
      tool: z.string(),
      target_substring: z.string().optional(),
    })).optional(),
    must_not_block: z.array(z.object({
      tool: z.string(),
      target_substring: z.string().optional(),
    })).optional(),
    must_be_empty: z.boolean().optional(),
    must_have_mood: z.enum(["angry", "frustrated", "neutral", "satisfied", "happy"]).optional(),
    must_have_trust: z.enum(["low", "normal", "high"]).optional(),
    must_not_have_mood: z.array(z.enum(["angry", "frustrated", "neutral", "satisfied", "happy"])).min(1).optional(),
    must_not_have_trust: z.array(z.enum(["low", "normal", "high"])).min(1).optional(),
    intent_must_contain: z.string().optional(),
  }).optional(),
  seed_state: z.object({
    currentPrediction: z.object({
      mood: z.enum(["angry", "frustrated", "neutral", "satisfied", "happy"]),
      trust: z.enum(["low", "normal", "high"]),
      intent: z.string(),
      blockedIntent: z.string(),
      explicitlyAllowedTools: z.array(z.string()),
      explicitlyBlockedSubstrings: z.array(z.object({
        tool: z.string(),
        targetSubstring: z.string().optional(),
        reason: z.string(),
      })),
      userMessageSnippet: z.string(),
      blockAllTools: z.boolean().optional(),
      timestamp: z.number().optional(),
      contextSwitch: z.enum(["yes", "no"]).optional(),
      questionIsStalling: z.enum(["yes", "no", "n/a"]).optional(),
    }),
    forceCheckPending: z.boolean(),
    frustrationStreak: z.number().int().nonnegative(),
    currentWindowSize: z.number().int().positive(),
    toolLog: z.array(z.object({
      ts: z.number().optional(),
      tool: z.string(),
      toolUseId: z.string().optional(),
      batchPosition: z.number().int().nonnegative().optional(),
      batchSize: z.number().int().positive().optional(),
      path: z.string().optional(),
      cmd: z.string().optional(),
      status: z.string(),
      gate: z.string(),
      reason: z.string().optional(),
      ms: z.number().optional(),
    })).optional(),
    driftState: z.record(
      z.string(),
      z.object({
        level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
        allowedSinceLevelChange: z.number().int().nonnegative(),
      }),
    ).optional(),
    planFile: z.object({
      slug: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
      content: z.string(),
    }).optional(),
  }),
});
