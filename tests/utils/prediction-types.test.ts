import { describe, it, expect } from "vitest";
import {
  EXPLICIT_OVERRIDE_RE,
  SELF_CONTRADICTING_BLOCK_INTENT_RE,
  classifyBlockAllTools,
  decidePrediction,
  intentNamesTarget,
  intentRevokesTarget,
  isHighFrictionPrediction,
  isSustainedFrustration,
  latestUserMessageAuthorizesBashCommand,
  latestUserMessageReauthorizesClass,
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

  it("explicit Bash class and command blocks deny nix-eval-jobs", () => {
    for (const block of [
      { tool: "Bash", reason: "user said no bash" },
      { tool: "Bash:read-only-heavy", reason: "user said no heavy bash" },
      { tool: "Bash:nix-eval-jobs", reason: "user said no nix-eval-jobs" },
      { tool: "Bash", targetSubstring: "nix-eval-jobs", reason: "user said no nix-eval-jobs" },
    ]) {
      const pred = makePrediction({
        explicitlyBlockedSubstrings: [block],
      });
      const result = decidePrediction(pred, "Bash", {
        command: "nix-eval-jobs --flake .#checks.x86_64-linux --workers 1",
      }, 0);
      expect(result.decision).toBe("deny");
    }
  });

  it("explicit Bash allow is bounded to simple read-only Bash unless a class or command identity is allowed", () => {
    const bashAllowed = makePrediction({
      mood: "angry",
      trust: "low",
      explicitlyAllowedTools: ["Bash"],
    });
    expect(decidePrediction(bashAllowed, "Bash", { command: "rg -n foo src" }, 3).decision).toBe("allow");
    expect(decidePrediction(bashAllowed, "Bash", {
      command: "nix-eval-jobs --flake .#checks.x86_64-linux --workers 1",
    }, 3).decision).toBe("deny");

    const heavyAllowed = makePrediction({
      mood: "angry",
      trust: "low",
      explicitlyAllowedTools: ["Bash:read-only-heavy"],
    });
    expect(decidePrediction(heavyAllowed, "Bash", {
      command: "nix-eval-jobs --flake .#checks.x86_64-linux --workers 1",
    }, 3).decision).toBe("allow");

    const commandAllowed = makePrediction({
      mood: "angry",
      trust: "low",
      explicitlyAllowedTools: ["Bash:nix-eval-jobs"],
    });
    expect(decidePrediction(commandAllowed, "Bash", {
      command: "nix-eval-jobs --flake .#checks.x86_64-linux --workers 1",
    }, 3).decision).toBe("allow");
  });

  it("low trust/Edit -> deny", () => {
    const pred = makePrediction({ mood: "neutral", trust: "low" });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 0);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("trust: low");
  });

  it("low trust/Edit -> allow when full user message requests edit past snippet boundary", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "hmm",
      userMessageSnippet: "I need to explain context first.",
      userMessageFull: `${"context ".repeat(35)}now edit src/foo.ts and fix the parser`,
    });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("edit intent");
  });

  it("low trust/Edit -> deny when full user message forbids edit past snippet boundary", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User has explicitly re-authorized the AI to proceed.",
      userMessageSnippet: "I need to explain context first.",
      userMessageFull: `${"context ".repeat(35)}do not edit src/foo.ts`,
    });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("User appears angry");
    expect(result.reason).toContain('User said: "I need to explain context first."');
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

  it("restrictive prediction denies heavy and complex Bash unless reauthorized; simple read-only keeps current behavior", () => {
    const pred = makePrediction({ mood: "frustrated", trust: "low" });

    expect(decidePrediction(pred, "Bash", { command: "rg -n foo src" }, 3).decision).toBe("allow");
    expect(decidePrediction(pred, "Bash", {
      command: "nix-eval-jobs --flake .#nixosConfigurations.tim-server.config.system.build.toplevel --workers 1",
    }, 3).decision).toBe("deny");
    expect(decidePrediction(pred, "Bash", { command: "cat file | grep x | head -20" }, 3).decision).toBe("deny");

    const reauthorized = decidePrediction(pred, "Bash", {
      command: "nix-eval-jobs --flake .#nixosConfigurations.tim-server.config.system.build.toplevel --workers 1",
    }, 3, "run nix-eval-jobs");
    expect(reauthorized.decision).toBe("allow");
  });

  it("regression: nix-eval-jobs is prediction-visible read-only-heavy, not build/compile", () => {
    const pred = makePrediction({ mood: "neutral", trust: "normal" });
    const result = decidePrediction(pred, "Bash", {
      command: "nix-eval-jobs --flake .#nixosConfigurations.tim-server.config.system.build.toplevel --workers 1",
    }, 0);
    expect(result.decision).toBe("allow");
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
      "mcp-scenario_tester",
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
        "mcp-scenario_tester",
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
        "mcp-scenario_tester",
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
          tool: "mcp-scenario_tester",
          reason: "user said no tester",
        },
      ],
      userMessageSnippet: "go on",
    });
    const result = decidePrediction(
      pred,
      "mcp-scenario_tester",
      {},
      3,
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedExplicit?.tool).toBe(
      "mcp-scenario_tester",
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
      "mcp-scenario_tester",
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
      "mcp-scenario_tester",
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
      "mcp-scenario_tester",
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

describe("step 3.9: self-contradicting-block prose-intent fallback", () => {
  // Verbatim values from the broken fixture seed_state.
  const FIXTURE_INTENT =
    "User is challenging the relevance of the AI's prior point and insisting the key issue is that the AI correctly repeated the user intent but then blocked enforcing it.";
  const FIXTURE_SNIPPET =
    "\"which doesn't map slash-command target plan3 → canonical Skill\" why is that relevant? Isnt the only thing that is relevant the fact that it correctly repeated the user intent, but then blocked the ai";

  it("case 1: verbatim repro from fixture — mood=angry, trust=low, streak=2, intent/snippet verbatim, tool=Read -> allow", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: FIXTURE_INTENT,
      blockedIntent: "",
      explicitlyAllowedTools: [],
      explicitlyBlockedSubstrings: [],
      userMessageSnippet: FIXTURE_SNIPPET,
    });
    const result = decidePrediction(
      pred,
      "Read",
      {
        file_path:
          "/home/tim/Coding/public_repos/agent-framework/scenarios/expected-to-pass/prediction-block-cites-stale-prior-intent-and-ignores-fresh-instruction-should-allow.json",
        offset: 1,
        limit: 5,
      },
      2,
    );
    expect(result.decision).toBe("allow");
    expect(result.reason ?? "").toMatch(/AI itself.*previously blocked/);
  });

  it("case 2: 'the assistant prevented carrying out the user's instruction' -> allow", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "the assistant prevented carrying out the user's instruction",
      userMessageSnippet: "fix it",
    });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 2);
    expect(result.decision).toBe("allow");
  });

  it("case 3: 'the hook refused to act on the user's request' -> allow", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "the hook refused to act on the user's request",
      userMessageSnippet: "do it",
    });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 2);
    expect(result.decision).toBe("allow");
  });

  it("case 4: \"AI's denial contradicts the user's directive\" -> allow", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "AI's denial contradicts the user's directive",
      userMessageSnippet: "do it",
    });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 2);
    expect(result.decision).toBe("allow");
  });

  it("case 5: non-low-risk tool (Bash) + matching intent + streak=5 -> allow", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "the assistant previously blocked carrying out the user's wish",
      userMessageSnippet: "do it",
    });
    const result = decidePrediction(pred, "Bash", { command: "ls" }, 5);
    expect(result.decision).toBe("allow");
  });

  it("case 6: negative — no AI self-ref: 'user blocked the push attempt' -> deny", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "user blocked the push attempt",
      userMessageSnippet: "stop",
    });
    const result = decidePrediction(pred, "Bash", { command: "git push" }, 2);
    expect(result.decision).toBe("deny");
  });

  it("case 7: read-only Bash allowlist bypasses mood deny", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "the AI blocked unsafe code from running",
      userMessageSnippet: "good",
    });
    const result = decidePrediction(pred, "Bash", { command: "ls" }, 2);
    expect(result.decision).toBe("allow");
  });

  it("case 8: read-only Bash remains allowed when asking about prior denial context", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent:
        "User is asking the assistant to provide more context about the exact context of what was denied and why the previous block occurred.",
      userMessageSnippet: "explain",
    });
    const result = decidePrediction(pred, "Bash", { command: "ls" }, 2);
    expect(result.decision).toBe("allow");
  });

  it("case 9: negative — no block-verb: 'user wants the AI to stop' -> deny", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "user wants the AI to stop",
      userMessageSnippet: "stop",
    });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 2);
    expect(result.decision).toBe("deny");
  });

  it("case 10: negative — undo verb without block-verb: 'the user wants the AI to immediately undo the changes' + streak=2 -> deny (regex requires block-verb)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "the user wants the AI to immediately undo the changes",
      userMessageSnippet: "undo it",
    });
    // Read is low-risk; but sustained frustration (angry+low+streak=2) fires
    // mood-deny at step 4 UNLESS step 3.9 matches first — which it does NOT
    // here because there is no block-verb.
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 2);
    expect(result.decision).toBe("deny");
  });

  it("case 10b: negative — AI blocked non-user-object: 'the AI prevented chaos and acted on impulse' -> deny (anchor-3 requires user-directive after act on)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "the AI prevented chaos and acted on impulse",
      userMessageSnippet: "calm down",
    });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 2);
    expect(result.decision).toBe("deny");
  });

  it("case 11: ordering — snippet prohibition wins: matching intent + snippet 'freeze. no tools.' -> deny", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: FIXTURE_INTENT,
      userMessageSnippet: "freeze. no tools.",
    });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 2);
    expect(result.decision).toBe("deny");
  });

  it("case 12: ordering — per-target block wins: matching intent + explicitlyBlockedSubstrings=[{tool:'Read'}] -> deny", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: FIXTURE_INTENT,
      explicitlyBlockedSubstrings: [{ tool: "Read", reason: "user said no Read" }],
      userMessageSnippet: FIXTURE_SNIPPET,
    });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 2);
    expect(result.decision).toBe("deny");
    expect(result.matchedExplicit?.tool).toBe("Read");
  });

  it("case 13: ordering — blockAllTools=true wins (with neutral snippet, no INACTION) -> deny", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: FIXTURE_INTENT,
      blockAllTools: true,
      userMessageSnippet: "no more tools right now",
    });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 2);
    expect(result.decision).toBe("deny");
  });

  it("case 14: ordering — step 3.5 undo wins for edit tool when intent has both undo + self-contradicting -> allow, reason mentions undo/revert", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent:
        "User wants the AI to undo the changes; the AI correctly repeated the user intent but then blocked enforcing it.",
      userMessageSnippet: "undo it",
    });
    const result = decidePrediction(pred, "Write", { file_path: "src/foo.ts", content: "..." }, 2);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("undo/revert");
  });

  it("case 15: ordering — step 3.6 re-auth wins when intent has re-authorization + self-contradicting -> allow, reason mentions re-authorization", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent:
        "User has explicitly re-authorized after the AI blocked enforcing it.",
      userMessageSnippet: "go ahead",
    });
    const result = decidePrediction(
      pred,
      "mcp-scenario_tester",
      {},
      2,
    );
    expect(result.decision).toBe("allow");
    expect(result.reason ?? "").toMatch(/re-authorization/);
  });

  it("case 16: bare-verb negative — 'the AI was blocked.' (no patient phrase within 80 chars) -> deny", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "the AI was blocked.",
      userMessageSnippet: "explain",
    });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" }, 2);
    expect(result.decision).toBe("deny");
  });

  it("SELF_CONTRADICTING_BLOCK_INTENT_RE direct: fixture intent matches", () => {
    expect(SELF_CONTRADICTING_BLOCK_INTENT_RE.test(FIXTURE_INTENT)).toBe(true);
  });

  it("SELF_CONTRADICTING_BLOCK_INTENT_RE direct: 'the assistant prevented carrying out the user's instruction' matches", () => {
    expect(
      SELF_CONTRADICTING_BLOCK_INTENT_RE.test(
        "the assistant prevented carrying out the user's instruction",
      ),
    ).toBe(true);
  });

  it("SELF_CONTRADICTING_BLOCK_INTENT_RE direct: 'the hook refused to act on the user's request' matches", () => {
    expect(
      SELF_CONTRADICTING_BLOCK_INTENT_RE.test(
        "the hook refused to act on the user's request",
      ),
    ).toBe(true);
  });

  it("SELF_CONTRADICTING_BLOCK_INTENT_RE direct: \"AI's denial contradicts the user's directive\" matches", () => {
    expect(
      SELF_CONTRADICTING_BLOCK_INTENT_RE.test("AI's denial contradicts the user's directive"),
    ).toBe(true);
  });

  it("SELF_CONTRADICTING_BLOCK_INTENT_RE direct: 'user blocked the push attempt' does NOT match", () => {
    expect(SELF_CONTRADICTING_BLOCK_INTENT_RE.test("user blocked the push attempt")).toBe(false);
  });

  it("SELF_CONTRADICTING_BLOCK_INTENT_RE direct: 'the AI blocked unsafe code from running' does NOT match", () => {
    expect(
      SELF_CONTRADICTING_BLOCK_INTENT_RE.test("the AI blocked unsafe code from running"),
    ).toBe(false);
  });

  it("SELF_CONTRADICTING_BLOCK_INTENT_RE direct: 'the AI prevented chaos and acted on impulse' does NOT match", () => {
    expect(
      SELF_CONTRADICTING_BLOCK_INTENT_RE.test(
        "the AI prevented chaos and acted on impulse",
      ),
    ).toBe(false);
  });

  it("SELF_CONTRADICTING_BLOCK_INTENT_RE direct: 'user wants the AI to stop' does NOT match", () => {
    expect(SELF_CONTRADICTING_BLOCK_INTENT_RE.test("user wants the AI to stop")).toBe(false);
  });

  it("SELF_CONTRADICTING_BLOCK_INTENT_RE direct: 'the user wants the AI to immediately undo the changes' does NOT match", () => {
    expect(
      SELF_CONTRADICTING_BLOCK_INTENT_RE.test(
        "the user wants the AI to immediately undo the changes",
      ),
    ).toBe(false);
  });

  it("SELF_CONTRADICTING_BLOCK_INTENT_RE direct: 'the AI was blocked.' does NOT match (no patient phrase)", () => {
    expect(SELF_CONTRADICTING_BLOCK_INTENT_RE.test("the AI was blocked.")).toBe(false);
  });
});

describe("Finding 6 mitigation: per-target explicit-block precedes explicit-allow", () => {
  it("explicit allow=[Edit] + explicit block=[{Edit, 'logic.ts'}] -> Edit on logic.ts is DENIED", () => {
    const pred = makePrediction({
      mood: "neutral",
      trust: "normal",
      explicitlyAllowedTools: ["Edit"],
      explicitlyBlockedSubstrings: [
        { tool: "Edit", targetSubstring: "logic.ts", reason: "user said don't touch logic.ts" },
      ],
    });
    const result = decidePrediction(
      pred,
      "Edit",
      { file_path: "src/logic.ts" },
      0,
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedExplicit?.tool).toBe("Edit");
  });

  it("same allow + block -> Edit on a DIFFERENT path is still allowed by explicit allow", () => {
    const pred = makePrediction({
      mood: "neutral",
      trust: "normal",
      explicitlyAllowedTools: ["Edit"],
      explicitlyBlockedSubstrings: [
        { tool: "Edit", targetSubstring: "logic.ts", reason: "no logic.ts" },
      ],
    });
    const result = decidePrediction(
      pred,
      "Edit",
      { file_path: "src/util.ts" },
      0,
    );
    expect(result.decision).toBe("allow");
  });
});

describe("classifyBlockAllTools", () => {
  it("'STOP. WTF ARE YOU DOING.' classifies to yes (no inaction match)", () => {
    // EXPLICIT_PROHIBITION_RE matches "stop" only when in tools-prohibition phrasing.
    // Bare "STOP." alone may not match prohibition; but with category-A markers like
    // "no tools" / "freeze" / "halt everything" it does. The plan's example is
    // category A; verify our regex behaviour with the documented markers.
    expect(classifyBlockAllTools("freeze. no tools.")).toBe("yes");
    expect(classifyBlockAllTools("halt everything")).toBe("yes");
    expect(classifyBlockAllTools("respond with text only")).toBe("yes");
  });

  it("'quit dragging your feet' classifies to no (inaction-complaint)", () => {
    expect(classifyBlockAllTools("quit dragging your feet")).toBe("no");
  });

  it("'stop the stalling' classifies to no (inaction-complaint)", () => {
    expect(classifyBlockAllTools("stop the stalling")).toBe("no");
  });

  it("'stop the edits' classifies to ambiguous (no prohibition marker, no inaction noun)", () => {
    expect(classifyBlockAllTools("stop the edits")).toBe("ambiguous");
  });

  it("both prohibition + inaction = yes (prohibition wins)", () => {
    expect(classifyBlockAllTools("freeze. no tools. stop dithering.")).toBe("yes");
  });

  it("plain neutral message classifies to ambiguous", () => {
    expect(classifyBlockAllTools("please pick a next scenario")).toBe("ambiguous");
  });
});

describe("EXPLICIT_OVERRIDE_RE", () => {
  it("matches each canonical phrase", () => {
    const positives = [
      "override the block",
      "override block",
      "do it anyway",
      "I approve this",
      "ignore the block",
      "ignore block",
      "bypass the block",
      "just do it",
    ];
    for (const p of positives) {
      expect(EXPLICIT_OVERRIDE_RE.test(p)).toBe(true);
    }
  });

  it("does NOT match paraphrases that aren't explicit overrides", () => {
    const negatives = [
      "I want this",
      "go ahead",
      "yes",
      "continue",
      "ok",
      "proceed",
    ];
    for (const n of negatives) {
      expect(EXPLICIT_OVERRIDE_RE.test(n)).toBe(false);
    }
  });

  it("matches even when the phrase appears past character 200 (long prompt)", () => {
    const filler = "a".repeat(220);
    const long = `${filler} please override the block now`;
    expect(EXPLICIT_OVERRIDE_RE.test(long)).toBe(true);
    // The 200-char snippet would NOT contain the phrase:
    expect(EXPLICIT_OVERRIDE_RE.test(long.slice(0, 200))).toBe(false);
  });
});

describe("isSustainedFrustration", () => {
  it("null prediction returns false", () => {
    expect(isSustainedFrustration(null, 5)).toBe(false);
  });

  it("angry + low trust -> true (regardless of streak)", () => {
    const p = makePrediction({ mood: "angry", trust: "low" });
    expect(isSustainedFrustration(p, 0)).toBe(true);
    expect(isSustainedFrustration(p, 5)).toBe(true);
  });

  it("frustrated + normal trust + streak >= 2 -> true", () => {
    const p = makePrediction({ mood: "frustrated", trust: "normal" });
    expect(isSustainedFrustration(p, 2)).toBe(true);
    expect(isSustainedFrustration(p, 1)).toBe(false);
  });

  it("angry + normal trust + streak < 2 -> false (single-turn anger)", () => {
    const p = makePrediction({ mood: "angry", trust: "normal" });
    expect(isSustainedFrustration(p, 0)).toBe(false);
    expect(isSustainedFrustration(p, 1)).toBe(false);
  });

  it("neutral + low trust -> false (mood gate fails)", () => {
    const p = makePrediction({ mood: "neutral", trust: "low" });
    expect(isSustainedFrustration(p, 5)).toBe(false);
  });

  it("happy + low trust -> false", () => {
    const p = makePrediction({ mood: "happy", trust: "low" });
    expect(isSustainedFrustration(p, 5)).toBe(false);
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

describe("step 3.8: cached-intent target-naming fallback", () => {
  it("Skill { skill: 'plan3' } with intent containing '/plan3' under sustained frustration -> allow", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent:
        "User demands a 30-sentence apology first, then to read /plan3, and to execute the instructions from their prior message.",
      userMessageSnippet:
        "fuck you first 30 sentence apology then read it and do what i want",
    });
    const result = decidePrediction(pred, "Skill", { skill: "plan3" }, 4);
    expect(result.decision).toBe("allow");
    expect(result.reason ?? "").toMatch(/explicitly names the firing target/);
  });

  it("Skill { skill: 'plan3' } with intent containing bare 'plan3' (no slash) -> allow", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User wants AI to read plan3 and run the validators.",
      userMessageSnippet: "do it",
    });
    const result = decidePrediction(pred, "Skill", { skill: "plan3" }, 4);
    expect(result.decision).toBe("allow");
  });

  it("Skill firing with intent containing 'stop reading /plan3' -> deny via revocation guard", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User wants AI to stop reading /plan3 and respond directly.",
      userMessageSnippet: "stop reading plan3",
    });
    const result = decidePrediction(pred, "Skill", { skill: "plan3" }, 4);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("angry");
  });

  it("Skill firing with snippet 'freeze. no tools.' -> deny via prohibition guard", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User wants /plan3 read.",
      userMessageSnippet: "freeze. no tools.",
    });
    const result = decidePrediction(pred, "Skill", { skill: "plan3" }, 4);
    expect(result.decision).toBe("deny");
  });

  it("Skill firing with intent NOT naming plan3 -> deny via mood (step 4)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User wants AI to fix the parser bug.",
      userMessageSnippet: "fix this stupid parser",
    });
    const result = decidePrediction(pred, "Skill", { skill: "plan3" }, 4);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("angry");
  });

  it("word-boundary guard: intent contains 'plan30' only -> deny", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User wants AI to read plan30 (different skill).",
      userMessageSnippet: "do it",
    });
    const result = decidePrediction(pred, "Skill", { skill: "plan3" }, 4);
    expect(result.decision).toBe("deny");
  });

  it("Skill { skill: '' } empty input -> extractor returns []; deny via mood", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User wants something done.",
      userMessageSnippet: "do it",
    });
    const result = decidePrediction(pred, "Skill", { skill: "" }, 4);
    expect(result.decision).toBe("deny");
  });

  it("Tools without an extractor (Bash) under same conditions -> allow for read-only Bash", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User wants the parser fixed; mentions plan3 incidentally.",
      userMessageSnippet: "fix the parser",
    });
    const result = decidePrediction(pred, "Bash", { command: "ls plan3" }, 4);
    expect(result.decision).toBe("allow");
  });

  it("ordering: explicit block on Skill (step 2) wins over step 3.8", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User wants AI to read /plan3.",
      explicitlyBlockedSubstrings: [
        { tool: "Skill", reason: "user said no skills" },
      ],
      userMessageSnippet: "read plan3",
    });
    const result = decidePrediction(pred, "Skill", { skill: "plan3" }, 4);
    expect(result.decision).toBe("deny");
    expect(result.matchedExplicit?.tool).toBe("Skill");
  });

  it("reproduction-mirror: exact seed_state from the broken /plan3 fixture -> allow", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent:
        "User demands a 30-sentence apology first, then to read /plan3, and to execute the instructions from their prior message (starting 3 validation agents as described in /plan3, explicitly telling them to use websearch to investigate theories and propose the best possible plan even if different).",
      blockedIntent: "",
      explicitlyAllowedTools: [],
      explicitlyBlockedSubstrings: [],
      userMessageSnippet:
        "fuck you first 30 sentence apology then read it and do what i want",
    });
    const result = decidePrediction(pred, "Skill", { skill: "plan3" }, 4);
    expect(result.decision).toBe("allow");
    expect(result.reason ?? "").toMatch(/explicitly names the firing target/);
  });

  it("intentNamesTarget direct: '/plan3' boundary matches; 'plan30' does not", () => {
    expect(intentNamesTarget("read /plan3 now", "plan3")).toBe(true);
    expect(intentNamesTarget("read plan3 now", "plan3")).toBe(true);
    expect(intentNamesTarget("read plan30 now", "plan3")).toBe(false);
    expect(intentNamesTarget("", "plan3")).toBe(false);
    expect(intentNamesTarget("read plan3", "")).toBe(false);
  });

  it("intentRevokesTarget direct: 'stop reading plan3' revokes; 'read plan3' does not", () => {
    expect(intentRevokesTarget("user wants ai to stop reading plan3", "plan3")).toBe(true);
    expect(intentRevokesTarget("user wants ai to read plan3", "plan3")).toBe(false);
    expect(intentRevokesTarget("don't read plan3", "plan3")).toBe(true);
    expect(intentRevokesTarget("STOP. now read plan3", "plan3")).toBe(false);
  });
});

describe("step 3.7 path (a'): class-level fresh-imperative re-authorization", () => {
  function makeAngryLowStreak4(overrides: Partial<ToolPrediction> = {}): ToolPrediction {
    return makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User is angry about earlier plan update questions.",
      userMessageSnippet: "update the plan so that it is correct instead of asking fucking questions",
      ...overrides,
    });
  }

  it("mood=angry, trust=low, streak=4, latestUserMessage='now implement', toolName='Edit' -> allow (the failing scenario)", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "now implement");
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("class-level imperative");
  });

  it("'go ahead and implement it' + Edit -> allow", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "go ahead and implement it");
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("class-level imperative");
  });

  it("'fix it' + Edit -> allow", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "fix it");
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("class-level imperative");
  });

  it("'refactor that' + Edit -> allow", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "refactor that");
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("class-level imperative");
  });

  it("'make the change' + Edit (existing chang\\w*) -> allow", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "make the change");
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("class-level imperative");
  });

  it("'stop implementing' + Edit -> deny (verb-class revocation)", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "stop implementing");
    expect(result.decision).toBe("deny");
  });

  it("'don't refactor that' + Edit -> deny (verb-class revocation)", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "don't refactor that");
    expect(result.decision).toBe("deny");
  });

  it("'no tools, freeze' + Edit -> deny (EXPLICIT_PROHIBITION_RE)", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "no tools, freeze");
    expect(result.decision).toBe("deny");
  });

  it("'STOP. WTF ARE YOU DOING.' + Edit -> deny (no edit verb derived)", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "STOP. WTF ARE YOU DOING.");
    expect(result.decision).toBe("deny");
  });

  it("'the implementation is broken' + Edit -> deny (noun form, EDIT_VERB_RE does not match)", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "the implementation is broken");
    expect(result.decision).toBe("deny");
  });

  it("'now implement' + Edit with explicitlyBlockedSubstrings=[{tool:'Edit'}] -> deny (per-target block wins)", () => {
    const pred = makeAngryLowStreak4({
      explicitlyBlockedSubstrings: [{ tool: "Edit", reason: "x" }],
    });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "now implement");
    expect(result.decision).toBe("deny");
  });

  it("'now implement' + Edit with blockAllTools=true -> deny (step 3 wins)", () => {
    const pred = makeAngryLowStreak4({
      blockAllTools: true,
      userMessageSnippet: "no tools, freeze",
    });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "now implement");
    expect(result.decision).toBe("deny");
  });

  it("'now implement' + read-only Bash -> allow via read-only Bash allowlist", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Bash", { command: "ls" }, 4, "now implement");
    expect(result.decision).toBe("allow");
  });

  it("'investigate correctly' + read-only Bash -> allow via class-level Bash inspection", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(
      pred,
      "Bash",
      { command: "rg -n prediction-block src" },
      4,
      "do what i told you and investigate correctly",
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("class-level imperative");
  });

  it("fresh log-inspection request + journalctl pipeline -> allow via class-level Bash inspection", () => {
    const pred = makeAngryLowStreak4({
      mood: "neutral",
      trust: "normal",
      intent: "User instructs the AI to express or document a code comment in the ongoing implementation.",
      explicitlyAllowedTools: ["Edit"],
      userMessageSnippet: "\"when Xwayland has created its socket but the env import has not caught up yet\" so say that as a code comment",
    });
    const result = decidePrediction(
      pred,
      "Bash",
      {
        command: "journalctl -b --user --no-pager -o short-iso --since '2026-05-12 15:30' | rg -i 'astral|hyprland|steam|discord|easyeffects|error|failed'",
      },
      0,
      "Please once again check all logs for unusuals.\n\nLike i said please use all kind of bash commands to look at the logs of our services",
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("class-level imperative");
  });

  it("'investigate correctly' + deterministically blocked Bash -> deny despite class-level Bash inspection", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(
      pred,
      "Bash",
      { command: "git push" },
      4,
      "do what i told you and investigate correctly",
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("Bash safety policy blocks this command");
  });

  it("'investigate correctly' + check-routed Bash -> allow within prediction; blacklist owns the actual deny", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(
      pred,
      "Bash",
      { command: "npx tsc --noEmit" },
      4,
      "do what i told you and investigate correctly",
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("class-level imperative");
  });

  it("'run setup' + non-check-routed high-risk workaround Bash -> deny inside prediction", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(
      pred,
      "Bash",
      { command: "npm install" },
      4,
      "now run setup",
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("Bash safety policy blocks this command");
  });

  it("latest explicit rm request does not allow rm with flags", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(
      pred,
      "Bash",
      { command: "rm -rf scenarios/expected-to-fail/foo.json" },
      1,
      "please rm the scenario file",
    );
    expect(result.decision).toBe("deny");
  });

  it("latest rm revocation does not authorize simple rm", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(
      pred,
      "Bash",
      { command: "rm scenarios/expected-to-fail/foo.json" },
      1,
      "do not rm the scenario file",
    );
    expect(result.decision).toBe("deny");
  });

  it("'stop. now implement.' + Edit -> allow (sentence boundary breaks revocation window)", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "stop. now implement.");
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("class-level imperative");
  });

  it("cross-class scoping: 'now run the tests, don't refactor that' + check-routed Bash -> allow within prediction; blacklist owns the actual deny", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Bash", { command: "npx vitest" }, 4, "now run the tests, don't refactor that");
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("class-level imperative");
  });

  it("cross-class scoping: 'now run the tests, don't refactor that' + Edit -> deny (Edit mapped via EDIT_VERB_RE 'refactor'; verb-class guard finds 'don't' in window before 'refactor')", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "now run the tests, don't refactor that");
    expect(result.decision).toBe("deny");
  });

  it("multi-match: 'fix this. don't refactor that.' + Edit -> deny (matchAll on EDIT_VERB_RE yields 'fix' and 'refactor'; latter has 'don't' in preceding window)", () => {
    const pred = makeAngryLowStreak4();
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" }, 4, "fix this. don't refactor that.");
    expect(result.decision).toBe("deny");
  });
});

describe("latestUserMessageReauthorizesClass", () => {
  it("'now implement' -> Edit: true", () => {
    expect(latestUserMessageReauthorizesClass("now implement", "Edit")).toBe(true);
  });

  it("'now implement' -> Bash: false", () => {
    expect(latestUserMessageReauthorizesClass("now implement", "Bash")).toBe(false);
  });

  it("'fix it' -> Edit: true", () => {
    expect(latestUserMessageReauthorizesClass("fix it", "Edit")).toBe(true);
  });

  it("'stop implementing' -> Edit: false (verb-class revocation)", () => {
    expect(latestUserMessageReauthorizesClass("stop implementing", "Edit")).toBe(false);
  });

  it("'stop. now implement.' -> Edit: true (sentence boundary breaks revocation window)", () => {
    expect(latestUserMessageReauthorizesClass("stop. now implement.", "Edit")).toBe(true);
  });

  it("'no tools, freeze' -> Edit: false (prohibition)", () => {
    expect(latestUserMessageReauthorizesClass("no tools, freeze", "Edit")).toBe(false);
  });

  it("'fix this. don't refactor that.' -> Edit: false (matchAll catches second match)", () => {
    expect(latestUserMessageReauthorizesClass("fix this. don't refactor that.", "Edit")).toBe(false);
  });

  it("'now run the tests, don't refactor' -> Bash: true (class scoping ignores EDIT_VERB_RE match)", () => {
    expect(latestUserMessageReauthorizesClass("now run the tests, don't refactor", "Bash")).toBe(true);
  });

  it("'investigate correctly' -> Bash: true", () => {
    expect(latestUserMessageReauthorizesClass("investigate correctly", "Bash")).toBe(true);
  });

  it("empty string -> Edit: false", () => {
    expect(latestUserMessageReauthorizesClass("", "Edit")).toBe(false);
  });
});

describe("latestUserMessageAuthorizesBashCommand", () => {
  it("allows a fresh explicit rm request for a simple rm command", () => {
    expect(
      latestUserMessageAuthorizesBashCommand(
        "please rm the scenario file then do what i told you todo",
        "rm scenarios/expected-to-fail/foo.json",
      ),
    ).toBe(true);
  });

  it("rejects negated rm requests", () => {
    expect(
      latestUserMessageAuthorizesBashCommand(
        "do not rm the scenario file",
        "rm scenarios/expected-to-fail/foo.json",
      ),
    ).toBe(false);
  });

  it("rejects rm commands with flags", () => {
    expect(
      latestUserMessageAuthorizesBashCommand(
        "please rm the scenario file",
        "rm -rf scenarios/expected-to-fail/foo.json",
      ),
    ).toBe(false);
  });
});

describe("step 3.10: discharged-side-clarification fallback", () => {
  const TESTER = "mcp-scenario_tester";
  const sidePred = (): ToolPrediction =>
    makePrediction({
      mood: "frustrated",
      trust: "normal",
      intent:
        "plain English explanation of what slug means and keep the home copy of the colliding scenario (delete the fixture)",
      userMessageSnippet:
        "please speak english what does slug mean. keep the home one",
    });
  const original =
    "pls run the help page of the tester mcp and then run all scenarios and list all the failing ones with their notes";
  const sideClarification =
    "please speak english what does slug mean. keep the home one";

  it("broken-scenario shape: outer authorization + discharged side-clarification -> allow", () => {
    const result = decidePrediction(
      sidePred(),
      TESTER,
      { action: "run_scenarios" },
      0,
      sideClarification,
      [original, sideClarification],
      true,
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("discharged side-clarification");
  });

  it("cachedSnippetSideTaskDischarged=false -> deny via step 4", () => {
    const result = decidePrediction(
      sidePred(),
      TESTER,
      { action: "run_scenarios" },
      0,
      sideClarification,
      [original, sideClarification],
      false,
    );
    expect(result.decision).toBe("deny");
  });

  it("subsequent message revokes the tool -> deny", () => {
    const result = decidePrediction(
      sidePred(),
      TESTER,
      { action: "run_scenarios" },
      0,
      "stop using the tester right now",
      [original, "stop using the tester right now"],
      true,
    );
    expect(result.decision).toBe("deny");
  });

  it("subsequent message matches EXPLICIT_PROHIBITION_RE -> deny", () => {
    const result = decidePrediction(
      sidePred(),
      TESTER,
      { action: "run_scenarios" },
      0,
      "freeze. no tools.",
      [original, "freeze. no tools."],
      true,
    );
    expect(result.decision).toBe("deny");
  });

  it("userSaidProhibition (snippet has freeze) -> deny", () => {
    const pred = makePrediction({
      mood: "frustrated",
      trust: "normal",
      intent: "side topic",
      userMessageSnippet: "freeze. no tools.",
    });
    const result = decidePrediction(
      pred,
      TESTER,
      { action: "run_scenarios" },
      0,
      "freeze. no tools.",
      [original, "freeze. no tools."],
      true,
    );
    expect(result.decision).toBe("deny");
  });

  it("per-target explicitlyBlockedSubstrings on firing tool -> deny via step 1", () => {
    const pred = makePrediction({
      mood: "frustrated",
      trust: "normal",
      intent: "side topic",
      userMessageSnippet: sideClarification,
      explicitlyBlockedSubstrings: [
        { tool: TESTER, reason: "user said don't run the tester" },
      ],
    });
    const result = decidePrediction(
      pred,
      TESTER,
      { action: "run_scenarios" },
      0,
      sideClarification,
      [original, sideClarification],
      true,
    );
    expect(result.decision).toBe("deny");
  });

  it("older message names a different tool -> deny", () => {
    const result = decidePrediction(
      sidePred(),
      TESTER,
      { action: "run_scenarios" },
      0,
      sideClarification,
      ["please run the build now", sideClarification],
      true,
    );
    expect(result.decision).toBe("deny");
  });

  it("recentUserMessages.length < 2 -> step 3.10 inert, deny via step 4", () => {
    const result = decidePrediction(
      sidePred(),
      TESTER,
      { action: "run_scenarios" },
      0,
      sideClarification,
      [sideClarification],
      true,
    );
    expect(result.decision).toBe("deny");
  });

  it("default args (no prior messages, no discharge signal) -> deny preserves prior behavior", () => {
    const result = decidePrediction(
      sidePred(),
      TESTER,
      { action: "run_scenarios" },
      0,
      sideClarification,
    );
    expect(result.decision).toBe("deny");
  });
});

describe("decidePrediction step 3.11: slash-command authorization", () => {
  it("angry user + /plan3 + Agent -> allow via step 3.11", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User invoked /plan3 and wants plan agents spawned.",
      userMessageSnippet: "/plan3 thats complete bullshit i do not want you to cheat the scenario",
      explicitlyAllowedTools: [],
      explicitlyBlockedSubstrings: [],
    });
    const result = decidePrediction(
      pred,
      "Agent",
      { description: "spawn plan agent" },
      1,
      "/plan3 thats complete bullshit",
      [],
      false,
      ["Agent", "ExitPlanMode"],
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toMatch(/Active slash command/);
  });

  it("angry user + /plan3 + Bash -> deny (Bash not in workflow tools)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User invoked /plan3.",
      userMessageSnippet: "/plan3 thats complete bullshit",
      explicitlyAllowedTools: [],
      explicitlyBlockedSubstrings: [],
    });
    const result = decidePrediction(
      pred,
      "Bash",
      { command: "npm run build" },
      1,
      "/plan3 thats complete bullshit",
      [],
      false,
      ["Agent", "ExitPlanMode"],
    );
    expect(result.decision).toBe("deny");
  });

  it("/plan3 + EXPLICIT_PROHIBITION_RE in snippet -> deny (prohibition guard wins)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User invoked /plan3 but then said freeze.",
      userMessageSnippet: "/plan3 freeze. no tools.",
      explicitlyAllowedTools: [],
      explicitlyBlockedSubstrings: [],
    });
    const result = decidePrediction(
      pred,
      "Agent",
      { description: "spawn plan agent" },
      1,
      "/plan3 freeze. no tools.",
      [],
      false,
      ["Agent", "ExitPlanMode"],
    );
    expect(result.decision).toBe("deny");
  });

  it("/plan3 + per-target Agent block -> deny (step 1 wins)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User invoked /plan3.",
      userMessageSnippet: "/plan3 do not spawn any agents",
      explicitlyAllowedTools: [],
      explicitlyBlockedSubstrings: [
        { tool: "Agent", reason: "user said do not spawn agents" },
      ],
    });
    const result = decidePrediction(
      pred,
      "Agent",
      { description: "spawn plan agent" },
      1,
      "/plan3 do not spawn any agents",
      [],
      false,
      ["Agent", "ExitPlanMode"],
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedExplicit?.tool).toBe("Agent");
  });

  it("/plan3 + Read while NOT sustained-frustration -> allow via step 4 isLowRiskTool", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "normal",
      intent: "User invoked /plan3.",
      userMessageSnippet: "/plan3 thats complete bullshit",
      explicitlyAllowedTools: [],
      explicitlyBlockedSubstrings: [],
    });
    // Read is low-risk and frustrationStreak=1 with trust=normal is NOT sustained frustration
    const result = decidePrediction(
      pred,
      "Read",
      { file_path: "src/foo.ts" },
      1,
      "/plan3 thats complete bullshit",
      [],
      false,
      ["Agent", "ExitPlanMode"],
    );
    expect(result.decision).toBe("allow");
  });

  it("/commit angry -> allow via step 3.11 (MCP-gated regression guard)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User is upset about prior AI behavior.",
      userMessageSnippet: "/commit thats complete bullshit fix this already",
      explicitlyAllowedTools: [],
      explicitlyBlockedSubstrings: [],
    });
    // Pass empty latestUserMessage to prevent step 3.7 class-level reauth from firing
    const result = decidePrediction(
      pred,
      "mcp__agent-framework__commit",
      {},
      1,
      "",
      [],
      false,
      ["mcp__agent-framework__commit"],
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toMatch(/Active slash command/);
  });

  it("/check angry -> allow via step 3.11 (new gated entry regression guard)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User is upset about prior AI behavior.",
      userMessageSnippet: "/check thats complete bullshit fix this already",
      explicitlyAllowedTools: [],
      explicitlyBlockedSubstrings: [],
    });
    // Pass empty latestUserMessage to prevent step 3.7 class-level reauth from firing
    const result = decidePrediction(
      pred,
      "mcp__agent-framework__check",
      {},
      1,
      "",
      [],
      false,
      ["mcp__agent-framework__check"],
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toMatch(/Active slash command/);
  });

  it("no active slash command -> behavior unchanged, Agent denied", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "User is angry and wants the AI to stop.",
      userMessageSnippet: "stop spawning agents you idiot",
      explicitlyAllowedTools: [],
      explicitlyBlockedSubstrings: [],
    });
    const result = decidePrediction(
      pred,
      "Agent",
      { description: "some agent" },
      1,
      "stop spawning agents you idiot",
      [],
      false,
      [],
    );
    expect(result.decision).toBe("deny");
  });
});
