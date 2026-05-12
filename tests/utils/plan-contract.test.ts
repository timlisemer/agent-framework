import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  extractRequiredFinalPlanHeadings,
  validatePlanContract,
} from "../../src/utils/plan-contract.js";

const required = [
  "User Goal",
  "Answered Assumptions",
  "Goal In My Words",
  "Approach",
  "Data Flow",
  "Files To Create",
  "Files To Modify",
  "Implementation Order",
  "Assistant Verification",
  "Manual User Verification",
  "Approaches Decided Against",
  "Possible Future Followups",
  "Relevant Files",
  "Files That Need Changes",
];

function withProject(fn: (projectDir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-contract-"));
  try {
    fs.writeFileSync(
      path.join(dir, "PLANS.md"),
      `# Planning Contract\n\n## Required Final Plan Structure\n\n${required.map((h, i) => `${i + 1}. \`## ${h}\``).join("\n")}\n\n## User Goal\n`,
    );
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function validPlan(): string {
  return required.map((heading) => {
    if (heading === "User Goal") return `## ${heading}\n\n> "Implement the requested hook change."`;
    if (heading === "Answered Assumptions") {
      return `## ${heading}\n\n1. The repo path is known. Answer: It is /repo. Source: User text.`;
    }
    if (heading === "Data Flow") {
      return `## ${heading}\n\nInput\n  |\n  v\nDetector\n  |\n  v\nHook output`;
    }
    if (heading === "Assistant Verification") {
      return `## ${heading}\n\nRun \`mcp__agent_framework__check\` with \`working_dir\` set to \`/repo\`.`;
    }
    if (heading === "Manual User Verification") {
      return `## ${heading}\n\nNo manual user verification is required.`;
    }
    return `## ${heading}\n\nThis section contains concrete repository-specific details for ${heading} with \`src/file.ts\` references.`;
  }).join("\n\n");
}

describe("plan contract", () => {
  it("extracts required headings from PLANS.md numbered list", () => {
    const text = "## Required Final Plan Structure\n\n1. `## User Goal`\n2. `## Answered Assumptions`\n\n## User Goal\n";
    expect(extractRequiredFinalPlanHeadings(text)).toEqual([
      "User Goal",
      "Answered Assumptions",
    ]);
  });

  it("skips contract findings when project PLANS.md is not readable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-contract-missing-"));
    try {
      expect(validatePlanContract("## User Goal\n> Do it.", dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a plan with exact required headings", () => {
    withProject((projectDir) => {
      expect(validatePlanContract(validPlan(), projectDir)).toEqual([]);
    });
  });

  it("ignores fenced and blockquoted headings while enforcing real level-two headings", () => {
    withProject((projectDir) => {
      const plan = validPlan().replace(
        "## Goal In My Words",
        "```md\n## Ignored Fence\n```\n> ## Ignored Quote\n### Goal In My Words",
      );
      const kinds = validatePlanContract(plan, projectDir).map((f) => f.kind);
      expect(kinds).toContain("required_heading_wrong_level");
      expect(kinds).toContain("missing_required_heading");
      expect(kinds).not.toContain("extra_level_two_heading");
    });
  });

  it("treats ## Test Plan as generic verification and extra level-two heading", () => {
    withProject((projectDir) => {
      const plan = validPlan().replace("## Manual User Verification", "## Test Plan\n\nRun tests.\n\n## Manual User Verification");
      const kinds = validatePlanContract(plan, projectDir).map((f) => f.kind);
      expect(kinds).toContain("generic_verification_heading");
      expect(kinds).toContain("extra_level_two_heading");
    });
  });

  it("flags vague and unresolved required section bodies", () => {
    withProject((projectDir) => {
      const plan = validPlan().replace(
        "This section contains concrete repository-specific details for Approach with `src/file.ts` references.",
        "Update things if needed.",
      );
      const kinds = validatePlanContract(plan, projectDir).map((f) => f.kind);
      expect(kinds).toContain("weak_or_vague_section_body");
      expect(kinds).toContain("unresolved_assumption_language");
    });
  });
});
