import { activeSpec } from "../../src/adapter/spec.js";

export const REQUIRED_FINAL_PLAN_HEADINGS = [
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

export function validPlanFixture(options: {
  planPath?: string;
  planName?: string;
  userGoal: string;
  answeredAssumptions: string;
  dataFlow: string;
  assistantVerification?: string;
  manualUserVerification?: string;
  sectionBody: (heading: string) => string;
}): string {
  const planPath = options.planPath ?? "/tmp/test-plan.md";
  const planName = options.planName ?? "test-plan";
  const assistantVerification = options.assistantVerification ??
    `Run \`${activeSpec().mcpWireName("check")}\` with \`working_dir\` set to \`/repo\`.`;
  const body = REQUIRED_FINAL_PLAN_HEADINGS.map((heading) => {
    if (heading === "User Goal") return `## ${heading}\n\n${options.userGoal}`;
    if (heading === "Answered Assumptions") {
      return `## ${heading}\n\n${options.answeredAssumptions}`;
    }
    if (heading === "Data Flow") return `## ${heading}\n\n${options.dataFlow}`;
    if (heading === "Assistant Verification") {
      return `## ${heading}\n\n${assistantVerification}`;
    }
    if (heading === "Manual User Verification") {
      return `## ${heading}\n\n${options.manualUserVerification ?? "No manual user verification is required."}`;
    }
    return `## ${heading}\n\n${options.sectionBody(heading)}`;
  }).join("\n\n");
  return `Plan Name: ${planName}\n\n${body}\n\nPlanfile Path: ${planPath}\nPlan Name: ${planName}`;
}
