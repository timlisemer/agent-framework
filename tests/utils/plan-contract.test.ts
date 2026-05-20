import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { activeSpec } from "../../src/adapter/spec.js";
import {
  extractRequiredFinalPlanHeadings,
  validatePlanContract,
} from "../../src/utils/plan-contract.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function validPlan(planPath = "/tmp/test-plan.md", planName = "test-plan"): string {
  const body = required.map((heading) => {
    if (heading === "User Goal") return `## ${heading}\n\n> "Implement the requested hook change."`;
    if (heading === "Answered Assumptions") {
      return `## ${heading}\n\n1. The repo path is known. Answer: It is /repo. Source: User text.`;
    }
    if (heading === "Data Flow") {
      return `## ${heading}\n\nInput\n  |\n  v\nDetector\n  |\n  v\nHook output`;
    }
    if (heading === "Assistant Verification") {
      return `## ${heading}\n\nRun \`${activeSpec().mcpWireName("check")}\` with \`working_dir\` set to \`/repo\`.`;
    }
    if (heading === "Manual User Verification") {
      return `## ${heading}\n\nNo manual user verification is required.`;
    }
    return `## ${heading}\n\nThis section contains concrete repository-specific details for ${heading} with \`src/file.ts\` references.`;
  }).join("\n\n");
  return `Plan Name: ${planName}\n\n${body}\n\nPlanfile Path: ${planPath}\nPlan Name: ${planName}`;
}

describe("plan contract", () => {
  it("extracts required headings from the planning contract numbered list", () => {
    const text = "## Required Final Plan Structure\n\n1. `## User Goal`\n2. `## Answered Assumptions`\n\n## User Goal\n";
    expect(extractRequiredFinalPlanHeadings(text)).toEqual([
      "User Goal",
      "Answered Assumptions",
    ]);
  });

  it("uses the agent-framework planning contract regardless of project files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-contract-missing-"));
    try {
      const kinds = validatePlanContract("## User Goal\n> Do it.", dir).map((f) => f.kind);
      expect(kinds).toContain("missing_plan_name");
      expect(kinds).toContain("missing_required_heading");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a plan with exact required headings", () => {
    withProject((projectDir) => {
      expect(validatePlanContract(validPlan(), projectDir)).toEqual([]);
    });
  });

  it("allows Assistant Verification to describe shell checks as owned by the check MCP", () => {
    withProject((projectDir) => {
      const assistantVerification = [
        "## Assistant Verification",
        "",
        "Run `mcp__agent_framework__scenario_tester` with `working_dir` set to `/repo` for the targeted scenario named `appeal-overturns-tool-approve-deny-when-user-literally-named-just-build`.",
        "",
        "Run `mcp__agent_framework__check` with `working_dir` set to `/repo` after each larger code change. Treat this MCP as the repository-level replacement for `cargo check`, `npm run check`, and other language-specific shell checks.",
      ].join("\n");
      const plan = validPlan().replace(
        /## Assistant Verification[\s\S]*?(?=\n\n## Manual User Verification)/,
        assistantVerification,
      );
      expect(validatePlanContract(plan, projectDir, {
        checkMcpWireName: activeSpec().mcpWireName("check"),
      })).toEqual([]);
    });
  });

  it("rejects direct project shell commands in Assistant Verification", () => {
    withProject((projectDir) => {
      const directCommands = [
        "Run `npm test`.",
        "After that, run `cargo check` before continuing.",
        "After the MCP, run `pnpm vitest` for the targeted suite.",
        "Run `npm jest` before the MCP.",
        "- `just check`",
        "```sh\ncargo check\n```",
      ];

      for (const body of directCommands) {
        const activeCheckMcp = activeSpec().mcpWireName("check");
        const plan = validPlan().replace(
          new RegExp(`Run \`${escapeRegExp(activeCheckMcp)}\` with \`working_dir\` set to \`/repo\`\\.`),
          [
            `Run \`${activeCheckMcp}\` with \`working_dir\` set to \`/repo\`.`,
            body,
          ].join("\n"),
        );
        const kinds = validatePlanContract(plan, projectDir, {
          checkMcpWireName: activeSpec().mcpWireName("check"),
        }).map((f) => f.kind);
        expect(kinds).toContain("assistant_verification_not_mcp_check");
      }
    });
  });

  it("flags footer plan name mismatches", () => {
    withProject((projectDir) => {
      const kinds = validatePlanContract(validPlan("/tmp/test-plan.md", "test-plan").replace(/Plan Name: test-plan$/, "Plan Name: other-plan"), projectDir).map((f) => f.kind);
      expect(kinds).toContain("plan_name_footer_mismatch");
    });
  });

  it("flags expected planfile path mismatches", () => {
    withProject((projectDir) => {
      const kinds = validatePlanContract(validPlan("/tmp/test-plan.md"), projectDir, { expectedPlanFile: "/tmp/other-plan.md" }).map((f) => f.kind);
      expect(kinds).toContain("planfile_path_mismatch");
    });
  });

  it("resolves relative footer planfile paths against the validator working directory", () => {
    withProject((projectDir) => {
      const planPath = path.join(projectDir, "plans", "test-plan.md");
      expect(validatePlanContract(validPlan("plans/test-plan.md"), projectDir, { expectedPlanFile: planPath })).toEqual([]);
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

  it("reports the exact unresolved assumption language", () => {
    withProject((projectDir) => {
      const plan = validPlan().replace(
        "This section contains concrete repository-specific details for Approach with `src/file.ts` references.",
        "Update `src/file.ts` if needed and probably adjust `tests/file.test.ts`.",
      );
      const finding = validatePlanContract(plan, projectDir).find((f) => f.kind === "unresolved_assumption_language");
      expect(finding?.message).toContain('"if needed"');
      expect(finding?.message).toContain('"probably"');
      expect(finding?.message).toContain("Line ");
    });
  });

  it("excludes User Goal body from content checks while preserving structure checks", () => {
    withProject((projectDir) => {
      const plan = validPlan().replace(
        '> "Implement the requested hook change."',
        [
          '> "Option A: run this over 5 days if needed."',
          '> "## Testing is quoted user text."',
        ].join("\n"),
      );
      const kinds = validatePlanContract(plan, projectDir).map((f) => f.kind);
      expect(kinds).not.toContain("live_option_menu");
      expect(kinds).not.toContain("schedule_bucket");
      expect(kinds).not.toContain("unresolved_assumption_language");
      expect(kinds).not.toContain("generic_verification_heading");
    });
  });

  it("still requires User Goal to use blockquote syntax", () => {
    withProject((projectDir) => {
      const plan = validPlan().replace(
        '> "Implement the requested hook change."',
        "Implement the requested hook change.",
      );
      const kinds = validatePlanContract(plan, projectDir).map((f) => f.kind);
      expect(kinds).toContain("missing_user_goal_quote");
    });
  });

  it("honors regex section exclusions for weak required section bodies", () => {
    const kinds = validatePlanContract(
      validPlan().replace(
        "This section contains concrete repository-specific details for Approach with `src/file.ts` references.",
        "Too short.",
      ),
      process.cwd(),
      { excludedContentSections: [/^Approach$/] },
    ).map((f) => f.kind);
    expect(kinds).not.toContain("weak_or_vague_section_body");
  });
});
