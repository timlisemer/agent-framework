export function formatImplementationValidatorFailureReport(input: {
  checkResults?: string;
  issues: readonly string[];
  rawOutput: string;
  errorCount?: number;
}): string {
  const issueLines = [
    ...input.issues,
    ...(input.errorCount === undefined ? [] : [`Errors: ${input.errorCount}`]),
  ];
  return `### Status: FAIL

### Changes Verified
(none)

### Check Results
${input.checkResults ?? "UNKNOWN"}

### Issues Found
${issueLines.join("\n")}

### Raw Output
${input.rawOutput}`;
}

export const IMPLEMENTATION_VALIDATOR_FORMAT_FALLBACK =
  formatImplementationValidatorFailureReport({
    issues: ["Validator returned malformed output."],
    rawOutput: "$RAW",
  });
