export function extractJsonContextMessage(stdout: string): string | null {
  if (!stdout.trim()) return null;
  try {
    const parsed = JSON.parse(stdout) as { systemMessage?: unknown };
    return typeof parsed.systemMessage === "string" ? parsed.systemMessage : null;
  } catch {
    return null;
  }
}
