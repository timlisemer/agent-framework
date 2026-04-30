import { describe, it, expect } from "vitest";
import {
  FABRICATED_DENY_FINGERPRINTS,
  FORBIDDEN_DENY_PATTERNS,
  isFabricatedDenyReason,
} from "../../../src/utils/fabricated-deny-patterns.js";

describe("FORBIDDEN_DENY_PATTERNS shape invariant", () => {
  it("each entry has a non-empty humanReadable AND a valid regex", () => {
    for (const { humanReadable, regex } of FORBIDDEN_DENY_PATTERNS) {
      expect(humanReadable.length).toBeGreaterThan(0);
      expect(regex).toBeInstanceOf(RegExp);
    }
  });
});

describe("FABRICATED_DENY_FINGERPRINTS", () => {
  it("is a non-empty array of RegExp", () => {
    expect(FABRICATED_DENY_FINGERPRINTS.length).toBeGreaterThan(0);
    for (const re of FABRICATED_DENY_FINGERPRINTS) {
      expect(re).toBeInstanceOf(RegExp);
    }
  });

  describe("isFabricatedDenyReason positive matches", () => {
    const positives: string[] = [
      "rg on local project file duplicates Read tool",
      "is duplicative of Read tool, which fetches file content",
      "ls duplicates Read/LS tools for directory listing; use Read or LS tool instead",
      "Bash command (rg/grep equivalent) duplicates Read tool for file inspection",
      "Bash awk pattern search duplicates Read tool",
      "use Read tool instead of grep",
      "Read tool can fetch the file for equivalent analysis",
      "Read fetches content for equivalent AI analysis",
      "cat/head/tail → DENY (use Read tool)\nNOTE: grep | head ...",
    ];

    for (const reason of positives) {
      it(`matches: ${reason.slice(0, 60)}`, () => {
        expect(isFabricatedDenyReason(reason)).toBe(true);
      });
    }
  });

  describe("isFabricatedDenyReason negative matches", () => {
    const negatives: string[] = [
      "Use Read tool",
      "Use Read tool with limit",
      "Use Read tool with offset",
      "git commit denied",
    ];

    for (const reason of negatives) {
      it(`does NOT match: ${reason}`, () => {
        expect(isFabricatedDenyReason(reason)).toBe(false);
      });
    }
  });
});
