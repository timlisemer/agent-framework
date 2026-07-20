import { describe, expect, it } from "vitest";
import {
  observableBlacklistPattern,
} from "../../src/rules/policy-observability.js";
import type {
  BlacklistPattern,
} from "../../src/utils/bash-policy/types.js";

function pattern(
  overrides: Partial<BlacklistPattern> = {},
): BlacklistPattern {
  return {
    pattern: /dangerous/,
    name: "dangerous command",
    alternative: "Use a safe tool",
    topic: "read-only",
    ...overrides,
  };
}

describe("blacklist policy observability", () => {
  it("uses stable function identities instead of implementation source text", () => {
    const commandMatcher = function matchesDangerousCommand(command: string) {
      return command.includes("dangerous");
    };
    const contentMatcher = function matchesDangerousContent(content: string) {
      return content.includes("dangerous");
    };

    const observed = observableBlacklistPattern(pattern({
      commandMatcher,
      contentMatcher,
    }));

    expect(observed.commandMatcher).toBe("matchesDangerousCommand");
    expect(observed.contentMatcher).toBe("matchesDangerousContent");
    expect(JSON.stringify(observed)).not.toContain("return command.includes");
    expect(JSON.stringify(observed)).not.toContain("return content.includes");
  });

  it("distinguishes matcher identities and dynamic alternatives explicitly", () => {
    const firstMatcher = function firstMatcher(command: string) {
      return command.length > 0;
    };
    const secondMatcher = function secondMatcher(command: string) {
      return command.length > 0;
    };
    const renderAlternative = function renderAlternative() {
      return "Use a safe tool";
    };

    const first = observableBlacklistPattern(pattern({
      commandMatcher: firstMatcher,
      alternative: renderAlternative,
    }));
    const second = observableBlacklistPattern(pattern({
      commandMatcher: secondMatcher,
      alternative: renderAlternative,
    }));

    expect(first.commandMatcher).toBe("firstMatcher");
    expect(second.commandMatcher).toBe("secondMatcher");
    expect(first.commandMatcher).not.toBe(second.commandMatcher);
    expect(first.alternative).toEqual({
      kind: "dynamic",
      functionName: "renderAlternative",
    });
  });

  it("keeps literal alternatives as literal policy values", () => {
    expect(observableBlacklistPattern(pattern()).alternative).toEqual({
      kind: "literal",
      value: "Use a safe tool",
    });
  });
});
