export function safeTimelineId(value: string, fallback = ""): string {
  return value.replace(/[^A-Za-z0-9_.:-]+/g, "-") || fallback;
}
