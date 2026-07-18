/** Parse an optional NOTE line from a gate or appeal result. */
export function extractGateNote(agentOutput: string): string | undefined {
  const match = agentOutput.match(/^NOTE:\s*(.+)$/m);
  return match ? match[1].trim() : undefined;
}
