export type ParsedCheckAgentResult = {
  errorCount: number;
  status: "PASS" | "FAIL" | "UNKNOWN";
  failed: boolean;
};

export function parseCheckAgentResult(output: string): ParsedCheckAgentResult {
  const errorMatch = output.match(/Errors:\s*(\d+)/i);
  const errorCount = errorMatch?.[1] ? parseInt(errorMatch[1], 10) : 0;
  const statusMatch = output.match(/Status:\s*(PASS|FAIL)/i);
  const rawStatus = statusMatch?.[1]?.toUpperCase();
  const status = rawStatus === "PASS" || rawStatus === "FAIL" ? rawStatus : "UNKNOWN";
  return {
    errorCount,
    status,
    failed: status === "FAIL" || errorCount > 0,
  };
}
