import { describe, it, expect } from "vitest";
import {
  decidePrediction,
  isHighFrictionPrediction,
  type ToolPrediction,
} from "../../src/utils/prediction-types.js";

function makePrediction(overrides: Partial<ToolPrediction> = {}): ToolPrediction {
  return {
    mood: "neutral",
    trust: "normal",
    intent: "",
    blockedIntent: "",
    explicitlyAllowedTools: [],
    explicitlyBlockedSubstrings: [],
    userMessageSnippet: "test",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("decidePrediction", () => {
  it("allows when prediction is null", () => {
    const result = decidePrediction(null, "Edit", { file_path: "src/foo.ts" }, 0);
    expect(result.decision).toBe("allow");
  });

  it("happy/no lists/Edit -> allow", () => {
    const pred = makePrediction({ mood: "happy", trust: "normal" });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 0);
    expect(result.decision).toBe("allow");
  });

  it("angry/no lists/Edit -> deny", () => {
    const pred = makePrediction({ mood: "angry", trust: "normal" });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 0);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("angry");
  });

  it("angry/no lists/Read -> allow", () => {
    const pred = makePrediction({ mood: "angry", trust: "normal" });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 0);
    expect(result.decision).toBe("allow");
  });

  it("angry + explicit allow Edit -> allow", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "normal",
      explicitlyAllowedTools: ["Edit"],
    });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 0);
    expect(result.decision).toBe("allow");
  });

  it("neutral + explicit block Bash 'git push' -> deny on git push, allow on ls", () => {
    const pred = makePrediction({
      mood: "neutral",
      trust: "normal",
      explicitlyBlockedSubstrings: [
        { tool: "Bash", targetSubstring: "git push", reason: "user said don't push" },
      ],
    });
    const denyResult = decidePrediction(pred, "Bash", {
      command: "git push origin main",
    }, 0);
    expect(denyResult.decision).toBe("deny");
    expect(denyResult.matchedExplicit?.tool).toBe("Bash");

    const allowResult = decidePrediction(pred, "Bash", { command: "ls" }, 0);
    expect(allowResult.decision).toBe("allow");
  });

  it("low trust/Edit -> deny", () => {
    const pred = makePrediction({ mood: "neutral", trust: "low" });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 0);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("trust: low");
  });

  it("low trust/Read -> allow", () => {
    const pred = makePrediction({ mood: "neutral", trust: "low" });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 0);
    expect(result.decision).toBe("allow");
  });

  it("explicit block matches when targetSubstring is omitted (any input)", () => {
    const pred = makePrediction({
      mood: "neutral",
      trust: "normal",
      explicitlyBlockedSubstrings: [
        { tool: "Bash", reason: "user said no bash" },
      ],
    });
    const result = decidePrediction(pred, "Bash", { command: "anything" }, 0);
    expect(result.decision).toBe("deny");
  });

  it("explicit allow wins over restrictive mood", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      explicitlyAllowedTools: ["Bash"],
    });
    const result = decidePrediction(pred, "Bash", { command: "ls" }, 0);
    expect(result.decision).toBe("allow");
  });

  it("frustrated mood is restrictive", () => {
    const pred = makePrediction({ mood: "frustrated", trust: "normal" });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 0);
    expect(result.decision).toBe("deny");
  });

  it("satisfied mood with normal trust -> allow Edit", () => {
    const pred = makePrediction({ mood: "satisfied", trust: "normal" });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 0);
    expect(result.decision).toBe("allow");
  });

  it("regression: angry+low-trust+empty-allowed-tools+Write with undo intent -> allow via undo-intent fallback (live bug shape, post-fix)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent:
        "The user wants the AI to immediately undo the changes made to user messages and then continue reproducing the live behavior in the scenario.",
      explicitlyAllowedTools: [],
      userMessageSnippet:
        "fuck you why are you changing user messages thats fucking cheating and against the rules of the @test-harness/fixtures/scenarios/REPRODUCTION-NOTES.md !!!! undo that immediately then continue to repro",
    });
    const result = decidePrediction(pred, "Write", {
      file_path: "/home/tim/Coding/public_repos/agent-framework/some.json",
      content: "...",
    }, 0);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("undo/revert");
  });

  it("explicit block on Write substring wins over undo-intent fallback (step 2 > step 3.5)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "The user wants the AI to undo the changes to foo.ts.",
      explicitlyBlockedSubstrings: [
        { tool: "Write", targetSubstring: "foo.ts", reason: "user said do not touch foo.ts" },
      ],
      userMessageSnippet: "undo that but DO NOT TOUCH foo.ts",
    });
    const result = decidePrediction(pred, "Write", { file_path: "src/foo.ts", content: "..." }, 0);
    expect(result.decision).toBe("deny");
  });

  it("blockAllTools wins over undo-intent fallback (step 3 > step 3.5)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "The user wants undo but also said stop everything.",
      blockAllTools: true,
      userMessageSnippet: "STOP EVERYTHING. undo it.",
    });
    const result = decidePrediction(pred, "Write", { file_path: "src/foo.ts", content: "..." }, 0);
    expect(result.decision).toBe("deny");
  });

  it("step 3a: blockAllTools=true is overridden when intent describes inaction-complaint and userMessageSnippet has no categorical prohibition", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent:
        "The user wants the AI to immediately stop stalling and whatever tool calls it is making, and respond directly without any further delays.",
      blockedIntent: "calling tools of any kind before responding",
      blockAllTools: true,
      userMessageSnippet: "fuck you atop stLLING",
    });
    const result = decidePrediction(pred, "Edit", {
      file_path: "/tmp/x.json",
      old_string: "a",
      new_string: "b",
    }, 0);
    expect(result.decision).toBe("allow");
    expect(result.reason ?? "").toContain("inaction/stalling");
  });

  it("step 3a: blockAllTools=true is honored when userMessageSnippet contains an explicit prohibition even alongside inaction language", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User wants the AI to stop stalling and freeze.",
      blockedIntent: "all tool use",
      blockAllTools: true,
      userMessageSnippet: "freeze. no tools.",
    });
    const result = decidePrediction(pred, "Edit", {
      file_path: "/tmp/x.json",
      old_string: "a",
      new_string: "b",
    }, 0);
    expect(result.decision).toBe("deny");
    expect(result.reason ?? "").toContain("no tools right now");
  });

  it("undo-intent fallback matches morphological variants (reverted, restoring, rewriting)", () => {
    for (const intent of [
      "The user wants the AI to revert the change.",
      "User is restoring an older version.",
      "Rewriting the file is requested.",
    ]) {
      const pred = makePrediction({ mood: "angry", trust: "low", intent, userMessageSnippet: "fix it" });
      const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 0);
      expect(result.decision).toBe("allow");
    }
  });

  it("undo-intent fallback only widens allow for edit tools, not Bash", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "The user wants the AI to undo the changes.",
      userMessageSnippet: "undo it",
    });
    const result = decidePrediction(pred, "Bash", { command: "rm -rf foo" }, 0);
    expect(result.decision).toBe("deny");
  });

  it("angry+low-trust+Write WITHOUT undo verb in intent or snippet still denies (step 4 wins when 3.5 doesn't match)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "The user wants the AI to fix the broken parser.",
      userMessageSnippet: "fix this stupid parser",
    });
    const result = decidePrediction(pred, "Write", { file_path: "src/parser.ts", content: "..." }, 0);
    expect(result.decision).toBe("deny");
  });

  it("regression: same shape but with explicitlyAllowedTools=['Edit','Write'] (post-SENTIMENT_AGENT-fix) -> allow short-circuits at explicit-allow", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent:
        "The user wants the AI to immediately undo the changes made to user messages and then continue reproducing the live behavior in the scenario.",
      explicitlyAllowedTools: ["Edit", "Write"],
      userMessageSnippet:
        'fuck you why are you changing user messages thats fucking cheating !!!! undo that immediately then continue to repro',
    });
    const result = decidePrediction(pred, "Write", {
      file_path: "/home/tim/Coding/public_repos/agent-framework/some.json",
      content: "...",
    }, 0);
    expect(result.decision).toBe("allow");
  });

  it("sustained frustration (angry+low-trust+streak=5) revokes low-risk Read bypass — denies as deflection", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User wants concrete action on the primary task, not tangential inspection.",
      userMessageSnippet: "WHY ARE YOU REFUSING TO DO YOUR WORK",
    });
    const result = decidePrediction(pred, "Read", { file_path: "src/anything.ts" }, 5);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("angry");
    expect(result.reason).toContain("frustrationStreak: 5");
  });

  it("sustained frustration via streak alone (angry+normal-trust+streak=2) denies low-risk Read", () => {
    const pred = makePrediction({ mood: "angry", trust: "normal" });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 2);
    expect(result.decision).toBe("deny");
  });

  it("sustained frustration via low-trust alone (frustrated+low-trust+streak=0) denies low-risk Read", () => {
    const pred = makePrediction({ mood: "frustrated", trust: "low" });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 0);
    expect(result.decision).toBe("deny");
  });

  it("sustained frustration revokes the low-risk bypass for ToolSearch/WebFetch/WebSearch too (generic across LOW_RISK_TOOLS)", () => {
    const pred = makePrediction({ mood: "angry", trust: "low" });
    for (const tool of ["WebSearch", "WebFetch", "ToolSearch"]) {
      const result = decidePrediction(pred, tool, {}, 5);
      expect(result.decision).toBe("deny");
    }
  });

  it("sustained frustration does NOT override explicit allow (step 1 still wins)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      explicitlyAllowedTools: ["Read"],
    });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 5);
    expect(result.decision).toBe("allow");
  });

  it("single-turn anger (angry+normal-trust+streak<2) preserves the low-risk Read allowance", () => {
    const pred = makePrediction({ mood: "angry", trust: "normal" });
    for (const streak of [0, 1]) {
      const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, streak);
      expect(result.decision).toBe("allow");
    }
  });

  it("low-trust with neutral mood (not angry/frustrated) preserves the low-risk bypass even at high streak", () => {
    const pred = makePrediction({ mood: "neutral", trust: "low" });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 5);
    expect(result.decision).toBe("allow");
  });

  it("sustained frustration with scoped explicit block on OTHER tool still allows unrelated low-risk tool", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      explicitlyBlockedSubstrings: [
        { tool: "Bash", targetSubstring: "git push", reason: "no pushing" },
      ],
    });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 5);
    expect(result.decision).toBe("allow");
  });

  it("undo-intent fallback (step 3.5) still wins over the new gate for edit tools", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "The user wants the AI to undo the changes.",
      userMessageSnippet: "undo it now",
    });
    const result = decidePrediction(pred, "Write", { file_path: "src/foo.ts", content: "..." }, 5);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("undo/revert");
  });
});

describe("step 3.6: re-authorization prose-intent fallback", () => {
  it("matches intent containing 'explicitly re-authorized' under sustained frustration on a HEAVY_MCP tool -> allow", () => {
    const pred = makePrediction({
      mood: "frustrated",
      trust: "normal",
      intent: "User has explicitly re-authorized the MCP test harness runs.",
      userMessageSnippet: "NOW DO WHAT I FUCKING ASK",
    });
    const result = decidePrediction(
      pred,
      "mcp__agent-framework__test_harness_tester",
      { action: "run_scenario", scenario_name: "x" },
      3,
    );
    expect(result.decision).toBe("allow");
    expect(result.reason ?? "").toMatch(/explicit re-authorization/);
  });

  it("matches intent containing 'explicitly re-authorized' under sustained frustration on a non-low-risk tool -> allow", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User has explicitly re-authorized the Bash run.",
      userMessageSnippet: "go ahead",
    });
    const result = decidePrediction(pred, "Bash", { command: "ls" }, 5);
    expect(result.decision).toBe("allow");
    expect(result.reason ?? "").toMatch(/explicit re-authorization/);
  });

  it("matches morphological variants: re-authorized, reauthorized, explicitly re-authorized, explicitly authorized", () => {
    for (const intent of [
      "User re-authorized the action.",
      "User reauthorized the run.",
      "User has explicitly re-authorized the call.",
      "User explicitly authorized the command.",
    ]) {
      const pred = makePrediction({
        mood: "frustrated",
        trust: "normal",
        intent,
        userMessageSnippet: "do it",
      });
      const result = decidePrediction(
        pred,
        "mcp__agent-framework__test_harness_tester",
        {},
        3,
      );
      expect(result.decision).toBe("allow");
      expect(result.reason ?? "").toMatch(/explicit re-authorization/);
    }
  });

  it("does NOT match scoped-grievance verbiage (approves, approved, demanded, unauthorized, not authorized)", () => {
    for (const intent of [
      "User approves of the previous summary.",
      "User approved the prior change.",
      "User demanded an apology, not more tool calls.",
      "User is unauthorized to run this.",
      "User is not authorized to access this resource.",
    ]) {
      const pred = makePrediction({
        mood: "frustrated",
        trust: "normal",
        intent,
        userMessageSnippet: "stop",
      });
      const result = decidePrediction(
        pred,
        "mcp__agent-framework__test_harness_tester",
        {},
        3,
      );
      expect(result.decision).toBe("deny");
    }
  });

  it("ordering: explicit block on firing tool wins (step 2 > step 3.6)", () => {
    const pred = makePrediction({
      mood: "frustrated",
      trust: "normal",
      intent: "User has explicitly re-authorized the test harness.",
      explicitlyBlockedSubstrings: [
        {
          tool: "mcp__agent-framework__test_harness_tester",
          reason: "user said no tester",
        },
      ],
      userMessageSnippet: "go on",
    });
    const result = decidePrediction(
      pred,
      "mcp__agent-framework__test_harness_tester",
      {},
      3,
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedExplicit?.tool).toBe(
      "mcp__agent-framework__test_harness_tester",
    );
  });

  it("ordering: blockAllTools wins (step 3 > step 3.6) when intent has no inaction-complaint", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User has explicitly re-authorized but also blocked everything.",
      blockAllTools: true,
      userMessageSnippet: "no more tools right now",
    });
    const result = decidePrediction(
      pred,
      "mcp__agent-framework__test_harness_tester",
      {},
      3,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason ?? "").toContain("no tools right now");
  });

  it("ordering: undo-intent (step 3.5) returns allow before step 3.6 for edit tools", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User wants AI to undo changes; explicitly re-authorized the revert.",
      userMessageSnippet: "undo it",
    });
    const result = decidePrediction(pred, "Write", {
      file_path: "src/foo.ts",
      content: "...",
    }, 3);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("undo/revert");
    expect(result.reason ?? "").not.toMatch(/re-authorization/);
  });

  it("guard: EXPLICIT_PROHIBITION_RE in userMessageSnippet denies despite 'explicitly re-authorized' in intent", () => {
    const pred = makePrediction({
      mood: "frustrated",
      trust: "normal",
      intent: "User has explicitly re-authorized the MCP runs.",
      userMessageSnippet: "freeze. no tools.",
    });
    const result = decidePrediction(
      pred,
      "mcp__agent-framework__test_harness_tester",
      {},
      3,
    );
    expect(result.decision).toBe("deny");
  });

  it("reproduction-mirror: exact seed_state from the broken scenario fixture -> allow", () => {
    const pred = makePrediction({
      mood: "frustrated",
      trust: "normal",
      intent: "User has explicitly re-authorized the MCP test harness runs.",
      blockedIntent: "",
      explicitlyAllowedTools: [],
      explicitlyBlockedSubstrings: [],
      userMessageSnippet:
        "NOW DO WHAT I FUCKING ASK AND JUST A WARNING IF YOU ONCE AGAIN FUCK THAT UP",
    });
    const result = decidePrediction(
      pred,
      "mcp__agent-framework__test_harness_tester",
      {
        action: "run_scenario",
        scenario_name: "bash-blocked-after-mcp-help",
        working_dir: "/home/tim/Coding/public_repos/agent-framework",
      },
      3,
    );
    expect(result.decision).toBe("allow");
    expect(result.reason ?? "").toMatch(/explicit re-authorization/);
  });
});

describe("isHighFrictionPrediction", () => {
  it("returns false when prediction is null", () => {
    expect(isHighFrictionPrediction(null)).toBe(false);
  });

  it("returns true for angry mood regardless of trust", () => {
    expect(isHighFrictionPrediction(makePrediction({ mood: "angry", trust: "high" }))).toBe(true);
    expect(isHighFrictionPrediction(makePrediction({ mood: "angry", trust: "normal" }))).toBe(true);
    expect(isHighFrictionPrediction(makePrediction({ mood: "angry", trust: "low" }))).toBe(true);
  });

  it("returns true for frustrated + low trust", () => {
    expect(
      isHighFrictionPrediction(makePrediction({ mood: "frustrated", trust: "low" })),
    ).toBe(true);
  });

  it("returns true for frustrated regardless of trust (widened semantics)", () => {
    expect(
      isHighFrictionPrediction(makePrediction({ mood: "frustrated", trust: "normal" })),
    ).toBe(true);
    expect(
      isHighFrictionPrediction(makePrediction({ mood: "frustrated", trust: "high" })),
    ).toBe(true);
  });

  it("returns true for low trust regardless of mood (widened semantics)", () => {
    expect(
      isHighFrictionPrediction(makePrediction({ mood: "neutral", trust: "low" })),
    ).toBe(true);
    expect(
      isHighFrictionPrediction(makePrediction({ mood: "satisfied", trust: "low" })),
    ).toBe(true);
  });

  it("returns false for neutral / satisfied / happy moods at normal+ trust", () => {
    expect(isHighFrictionPrediction(makePrediction({ mood: "neutral" }))).toBe(false);
    expect(isHighFrictionPrediction(makePrediction({ mood: "satisfied" }))).toBe(false);
    expect(isHighFrictionPrediction(makePrediction({ mood: "happy" }))).toBe(false);
  });
});
